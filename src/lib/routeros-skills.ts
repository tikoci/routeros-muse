// T100: offline delivery of the package-pinned RouterOS skills into a
// worker's private Muse config home. The manifest owns individual files,
// never a whole user directory. Changed/unowned files are left alone.
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { packageRoot } from "./tools";

const MANIFEST = "routeros-muse-skills.json";
const LOCK = ".routeros-muse-skills.lock";
const NAME = /^routeros-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_FILE = 8 * 1024 * 1024;

type Files = Record<string, string>;
type Manifest = {
	version: 1;
	source: string;
	revision: string;
	skills: Record<string, Files>;
};
export type SkillsBundle = {
	source: string;
	revision: string;
	skills: Map<string, Map<string, Buffer>>;
};
export type RouterosSkillsReport = {
	enabled: boolean;
	revision: string | null;
	/** Successfully managed skills, not a claim about a model's catalog. */
	staged: string[];
	warnings: string[];
	error: string | null;
};

export type SkillsVerification = {
	loaded: string[];
	workspaceOverrides: string[];
	personalCopiesShadowed: number;
	warnings: string[];
};

/** CLI supplies full-catalog paths/diagnostics; MSP supplies invocable rows. */
export function compareRouterosCatalogs(args: {
	bundle: SkillsBundle;
	staged: string[];
	privateHome: string;
	msp: { skills: { selector: string; source: string }[] };
	cli: {
		skills: {
			name: string;
			scope: string;
			path: string;
			activation?: string;
		}[];
		diagnostics: { code: string; path: string; message: string }[];
	};
}): SkillsVerification {
	const loaded: string[] = [];
	const workspaceOverrides: string[] = [];
	const warnings: string[] = [];
	let personalCopiesShadowed = 0;
	for (const name of args.staged) {
		const row = args.cli.skills.find((r) => r.name === name);
		if (row?.scope === "project") {
			workspaceOverrides.push(name);
			continue;
		}
		const expectedPath = path.join(
			args.privateHome,
			"muse",
			"skills",
			name,
			"SKILL.md",
		);
		if (
			row?.scope !== "user" ||
			(row.path !== expectedPath &&
				row.path !== `$CONFIG_DIR/skills/${name}/SKILL.md`)
		) {
			warnings.push(`${name}: bundled skill missing from Muse's full catalog`);
			continue;
		}
		if (row.activation === "off") {
			warnings.push(`${name}: disabled in Muse's skill activation settings`);
			continue;
		}
		const body =
			args.bundle.skills.get(name)?.get("SKILL.md")?.toString() ?? "";
		const invocable = !/^user-invocable:\s*false\s*$/m.test(body);
		if (
			invocable &&
			!args.msp.skills.some((r) => r.selector === name && r.source === "user")
		) {
			warnings.push(`${name}: bundled skill missing from the session catalog`);
			continue;
		}
		loaded.push(name);
	}
	for (const d of args.cli.diagnostics) {
		if (!/[/\\]routeros-[^/\\]+[/\\]/.test(d.path ?? "")) continue;
		if (d.code === "skill-shadowed") {
			if ((d.path ?? "").includes(".agents/skills/")) personalCopiesShadowed++;
			continue;
		}
		warnings.push(`${d.code}: ${d.message}`);
	}
	if (workspaceOverrides.length)
		warnings.push(
			`Workspace skills override bundled copies: ${workspaceOverrides.join(", ")}`,
		);
	return { loaded, workspaceOverrides, personalCopiesShadowed, warnings };
}

function missing(err: unknown): boolean {
	return (err as NodeJS.ErrnoException).code === "ENOENT";
}
function stat(file: string): fs.Stats | null {
	try {
		return fs.lstatSync(file);
	} catch (err) {
		if (missing(err)) return null;
		throw err;
	}
}
function plainDir(dir: string): void {
	const info = stat(dir);
	if (info && (!info.isDirectory() || info.isSymbolicLink()))
		throw new Error(
			`RouterOS skills: refused non-directory or symlink at ${dir}`,
		);
}
function read(file: string): Buffer {
	const fd = fs.openSync(
		file,
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
	);
	try {
		const info = fs.fstatSync(fd);
		if (!info.isFile() || info.size > MAX_FILE)
			throw new Error(
				`RouterOS skills: refused non-regular or oversized file ${file}`,
			);
		return fs.readFileSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}
function hash(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function relativeFile(file: string): boolean {
	return (
		file.length > 0 &&
		!/[\\:]/.test(file) &&
		!path.posix.isAbsolute(file) &&
		file
			.split("/")
			.every((part) => part !== "" && part !== "." && part !== "..")
	);
}

/** Never follow internal symlinks, including references and old destinations. */
function walk(dir: string): Map<string, Buffer> {
	const files = new Map<string, Buffer>();
	function visit(folder: string, prefix: string): void {
		plainDir(folder);
		for (const name of fs.readdirSync(folder).sort()) {
			const rel = prefix ? `${prefix}/${name}` : name;
			if (!relativeFile(rel))
				throw new Error(`RouterOS skills: invalid file ${rel}`);
			const file = path.join(folder, name);
			const info = fs.lstatSync(file);
			if (info.isDirectory()) visit(file, rel);
			else if (info.isFile()) files.set(rel, read(file));
			else
				throw new Error(
					`RouterOS skills: refused special file or symlink ${file}`,
				);
		}
	}
	visit(dir, "");
	return files;
}

/** Resolve from our installed package, supporting hoisted node_modules too. */
export function loadRouterosSkills(
	pkgRoot: string | null = packageRoot(),
): SkillsBundle {
	if (!pkgRoot)
		throw new Error("RouterOS skills: cannot find routeros-muse package");
	const pkgFile = path.join(pkgRoot, "package.json");
	const pkg = JSON.parse(read(pkgFile).toString()) as {
		dependencies?: Record<string, string>;
	};
	const source = pkg.dependencies?.["routeros-skills"] ?? "";
	const revision = /^github:tikoci\/routeros-skills#([a-f0-9]{40})$/.exec(
		source,
	)?.[1];
	if (!revision)
		throw new Error("RouterOS skills: dependency must pin a full Git SHA");
	let root: string;
	try {
		root = path.dirname(
			createRequire(pkgFile).resolve("routeros-skills/package.json"),
		);
	} catch {
		throw new Error(
			"RouterOS skills package missing; run bun install for routeros-muse",
		);
	}
	// Package managers may symlink the package root; its contents must be plain.
	root = fs.realpathSync(root);
	const skills = new Map<string, Map<string, Buffer>>();
	for (const name of fs.readdirSync(root).sort()) {
		if (!NAME.test(name)) continue;
		const files = walk(path.join(root, name));
		const body = files.get("SKILL.md")?.toString();
		if (!body || !/^---\r?\n[\s\S]*?\r?\n---/.test(body))
			throw new Error(`RouterOS skills: missing skill frontmatter in ${name}`);
		const declared = /^name:\s*["']?([a-z0-9-]+)["']?\s*$/m.exec(body)?.[1];
		if (declared !== name)
			throw new Error(`RouterOS skills: name mismatch in ${name}/SKILL.md`);
		skills.set(name, files);
	}
	if (!skills.size)
		throw new Error("RouterOS skills package contains no skills");
	return { source, revision, skills };
}

function readManifest(file: string): Manifest | null {
	if (!stat(file)) return null;
	const doc = JSON.parse(read(file).toString()) as Manifest;
	if (
		doc.version !== 1 ||
		typeof doc.source !== "string" ||
		typeof doc.revision !== "string" ||
		!doc.skills ||
		typeof doc.skills !== "object" ||
		Array.isArray(doc.skills)
	)
		throw new Error("RouterOS skills: invalid ownership manifest");
	for (const [name, files] of Object.entries(doc.skills)) {
		if (
			!NAME.test(name) ||
			!files ||
			typeof files !== "object" ||
			Array.isArray(files)
		)
			throw new Error("RouterOS skills: invalid manifest skill");
		for (const [rel, sha] of Object.entries(files))
			if (!relativeFile(rel) || typeof sha !== "string" || !HASH.test(sha))
				throw new Error("RouterOS skills: invalid manifest file or hash");
	}
	return doc;
}

/** Fully write a sibling, then atomically replace owned files or create exclusively. */
function write(file: string, bytes: Buffer, replace: boolean): void {
	const tmp = `${file}.${randomUUID()}.tmp`;
	const fd = fs.openSync(tmp, "wx", 0o600);
	try {
		try {
			fs.writeFileSync(fd, bytes);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		if (replace) fs.renameSync(tmp, file);
		else fs.linkSync(tmp, file); // EEXIST never overwrites somebody else's create.
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// Preserve the original write failure.
		}
		throw err;
	}
	if (!replace) fs.unlinkSync(tmp);
}

/** A second server cannot interleave a reconciliation. No waiting or live-owner theft. */
function lock(dir: string): () => void {
	const file = path.join(dir, LOCK);
	let created = false;
	try {
		const fd = fs.openSync(file, "wx", 0o600);
		created = true;
		try {
			fs.writeFileSync(fd, String(process.pid));
		} finally {
			fs.closeSync(fd);
		}
	} catch (err) {
		if (created) {
			try {
				fs.unlinkSync(file);
			} catch {
				/* preserve the original lock-write error */
			}
			throw err;
		}
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		const before = stat(file);
		const pid = Number(read(file).toString());
		if (!Number.isSafeInteger(pid) || pid <= 0)
			throw new Error(
				"RouterOS skills: incomplete delivery lock; retry after checking the private home",
			);
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ESRCH") alive = false;
		}
		const after = stat(file);
		if (
			alive ||
			!before ||
			!after ||
			before.ino !== after.ino ||
			before.dev !== after.dev
		)
			throw new Error(
				"RouterOS skills: another process is updating this private home; retry shortly",
			);
		fs.unlinkSync(file);
		return lock(dir);
	}
	return () => fs.unlinkSync(file);
}

export function routerosSkillsManifest(privateHome: string): string {
	return path.join(privateHome, "muse", MANIFEST);
}

/**
 * The caller first ensures the existing private home (including its data-home
 * ancestors). This function checks everything below it before touching files.
 * Like init/preallow, this assumes no adversarial parent-directory swaps.
 */
export function stageRouterosSkills(args: {
	privateHome: string;
	enabled: boolean;
	bundle?: SkillsBundle;
}): RouterosSkillsReport {
	const { privateHome, enabled } = args;
	const muse = path.join(privateHome, "muse");
	const dest = path.join(muse, "skills");
	plainDir(privateHome);
	plainDir(muse);
	plainDir(dest);
	const manifestFile = routerosSkillsManifest(privateHome);
	// Refuse a linked manifest even when off; read() also refuses special files.
	const bundle = enabled ? (args.bundle ?? loadRouterosSkills()) : null;
	for (const [name, files] of bundle?.skills ?? []) {
		if (!NAME.test(name) || [...files.keys()].some((rel) => !relativeFile(rel)))
			throw new Error("RouterOS skills: invalid bundle path");
	}
	const release = lock(muse);
	try {
		const old = readManifest(manifestFile);
		const next: Manifest = {
			version: 1,
			source: bundle?.source ?? old?.source ?? "",
			revision: bundle?.revision ?? old?.revision ?? "",
			skills: {},
		};
		const warnings: string[] = [];
		const staged: string[] = [];
		const names = new Set([
			...Object.keys(old?.skills ?? {}),
			...(bundle?.skills.keys() ?? []),
		]);
		// Read and validate every affected destination before the first mutation.
		const current = new Map<string, Map<string, Buffer>>();
		for (const name of names) {
			const dir = path.join(dest, name);
			if (stat(dir)) current.set(name, walk(dir));
		}
		for (const name of names) {
			const prior = old?.skills[name];
			const actual = current.get(name);
			const wanted = bundle?.skills.get(name);
			const dir = path.join(dest, name);
			if (
				!prior &&
				actual &&
				[...(wanted?.keys() ?? [])].some((rel) => actual.has(rel))
			) {
				warnings.push(
					`${name}: existing private skill left unchanged (not managed by RouterOS Muse)`,
				);
				continue;
			}
			const changed = Object.entries(prior ?? {}).filter(([rel, sha]) => {
				const bytes = actual?.get(rel);
				return bytes !== undefined && hash(bytes) !== sha;
			});
			const collisions = [...(wanted?.keys() ?? [])].filter(
				(rel) => actual?.has(rel) && !Object.hasOwn(prior ?? {}, rel),
			);
			if (wanted && (changed.length || collisions.length)) {
				warnings.push(
					`${name}: local edits or unowned files preserved; package update skipped`,
				);
				if (prior) next.skills[name] = prior;
				continue;
			}
			const owned: Files = Object.create(null);
			for (const [rel, sha] of Object.entries(prior ?? {})) {
				if (wanted?.has(rel)) continue;
				const bytes = actual?.get(rel);
				if (!bytes) continue;
				if (hash(bytes) === sha) fs.unlinkSync(path.join(dir, rel));
				else {
					owned[rel] = sha;
					warnings.push(
						`${name}/${rel}: local edit preserved; it may still load in Muse`,
					);
				}
			}
			if (wanted) {
				for (const [rel, bytes] of wanted) {
					const file = path.join(dir, rel);
					fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
					const sha = hash(bytes);
					if (!actual?.has(rel) || hash(actual.get(rel) as Buffer) !== sha)
						write(file, bytes, actual?.has(rel) ?? false);
					owned[rel] = sha;
				}
				staged.push(name);
			}
			if (Object.keys(owned).length) next.skills[name] = owned;
			// Remove empty managed directories only; unrelated additions survive.
			if (stat(dir)) {
				const dirs = new Set([dir]);
				for (const rel of Object.keys(prior ?? {})) {
					let parent = path.dirname(path.join(dir, rel));
					while (parent !== dir) {
						dirs.add(parent);
						parent = path.dirname(parent);
					}
				}
				for (const folder of [...dirs].sort((a, b) => b.length - a.length)) {
					try {
						fs.rmdirSync(folder);
					} catch (err) {
						const code = (err as NodeJS.ErrnoException).code;
						if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST")
							throw err;
					}
				}
			}
		}
		const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
		if (!old || !read(manifestFile).equals(bytes))
			write(manifestFile, bytes, old !== null);
		return {
			enabled,
			revision: bundle?.revision ?? old?.revision ?? null,
			staged: staged.sort(),
			warnings,
			error: null,
		};
	} finally {
		release();
	}
}
