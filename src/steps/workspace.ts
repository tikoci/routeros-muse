// Step 4: workspace. Clone (git home) or open the folder (synced
// home), then validate: workspace.toml parses, this copy claims
// canonical = true, AGENTS.md present. Conflict copies are refused
// with the single-canonical guard, never merged.

import * as nodeFs from "node:fs";
import * as path from "node:path";
import { type Ctx, resumeLine } from "../ctx";
import { ask, isTty } from "../lib/prompt";
import { have, run } from "../lib/run";
import { Stop } from "../lib/stop";
import { parseToml } from "../lib/toml";

export type WorkspaceConfig = {
	home: Record<string, unknown>;
	pins: Record<string, unknown>;
};

export function isGitUrl(s: string): boolean {
	return (
		/^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)/.test(s) ||
		/\.git\/?$/.test(s)
	);
}

function cloneBase(url: string): string {
	const clean = url.replace(/\/$/, "").replace(/\.git$/, "");
	const last = clean.split(/[/:]/).at(-1) ?? "workspace";
	return last || "workspace";
}

async function cloneHome(url: string, ctx: Ctx): Promise<string> {
	if (!have("git")) {
		throw new Stop([
			"A git home needs git, and git is not installed (print-only; the bootstrap never sudo-installs).",
			"Install git, then resume with:",
			`  ${resumeLine(ctx)}`,
		]);
	}
	const def = path.resolve(process.cwd(), cloneBase(url));
	let target = def;
	if (isTty()) {
		const answer = await ask(`Clone into directory [${def}]:`);
		if (answer) target = path.resolve(process.cwd(), answer);
	}
	if (nodeFs.existsSync(target)) {
		throw new Stop([
			`Refusing to clone into ${target}: it already exists.`,
			"Pick an empty target or open it as a folder.",
		]);
	}
	console.log(`  $ git clone ${url} ${target}`);
	const r = await run(["git", "clone", url, target], { timeoutMs: 300_000 });
	if (!r.ok) {
		throw new Stop([
			`git clone failed (exit ${r.exit}): ${r.stderr.trim().split("\n").at(-1) ?? ""}`,
		]);
	}
	return target;
}

const SKIP_DIRS = new Set([".git", "node_modules"]);
const WALK_CAP = 3000;

/**
 * Conflict-copy patterns: Dropbox "conflicted copy" and Syncthing
 * "sync-conflict" anywhere; Drive-style " (N)" duplicates only for
 * .md/.toml, where a dupe breaks canonical reads.
 */
export function isConflictName(name: string): boolean {
	if (/conflicted copy/i.test(name)) return true;
	if (/sync-conflict/i.test(name)) return true;
	if (/ \(\d+\)\.(md|toml)$/i.test(name)) return true;
	return false;
}

export function findConflictCopies(root: string): {
	hits: string[];
	capped: boolean;
} {
	const hits: string[] = [];
	let seen = 0;
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let entries: string[];
		try {
			entries = [...new Bun.Glob("*").scanSync({ cwd: dir, onlyFiles: false })];
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (++seen > WALK_CAP) return { hits, capped: true };
			const full = path.join(dir, entry);
			try {
				const st = nodeFs.statSync(full);
				if (st.isDirectory()) {
					if (!SKIP_DIRS.has(entry)) stack.push(full);
					continue;
				}
			} catch {
				continue;
			}
			if (isConflictName(entry)) hits.push(path.relative(root, full));
		}
	}
	return { hits, capped: false };
}

export type ValidateResult =
	| { ok: true; config: WorkspaceConfig }
	| { ok: false; reason: string[] };

export async function readAndValidate(dir: string): Promise<ValidateResult> {
	const tomlPath = path.join(dir, "workspace.toml");
	if (!(await Bun.file(tomlPath).exists())) {
		return {
			ok: false,
			reason: [`${tomlPath} not found: not a network workspace.`],
		};
	}
	const parsed = parseToml(await Bun.file(tomlPath).text());
	if (!parsed.ok) {
		return {
			ok: false,
			reason: [`workspace.toml does not parse: ${parsed.error}`],
		};
	}
	const home = parsed.value["home"];
	if (home === null || typeof home !== "object" || Array.isArray(home)) {
		return { ok: false, reason: ["workspace.toml has no [home] table."] };
	}
	if ((home as Record<string, unknown>)["canonical"] !== true) {
		return {
			ok: false,
			reason: [
				"This copy does not claim canonical = true, so the bootstrap will not work here.",
				"Open the canonical copy (secondaries carry age manifests, never edits).",
			],
		};
	}
	if (!(await Bun.file(path.join(dir, "AGENTS.md")).exists())) {
		return {
			ok: false,
			reason: ["AGENTS.md is missing: not a network workspace."],
		};
	}
	const { hits, capped } = findConflictCopies(dir);
	if (hits.length > 0) {
		const shown = hits.slice(0, 10).map((h) => `  - ${h}`);
		if (hits.length > 10) shown.push(`  ... and ${hits.length - 10} more`);
		return {
			ok: false,
			reason: [
				"Conflict copies found: refusing with the single-canonical guard (never merged).",
				"Reconcile by hand, delete the dupes, then resume.",
				...shown,
			],
		};
	}
	if (capped) {
		console.log(
			"  (conflict scan hit its entry cap; deep trees are only shallow-scanned)",
		);
	}
	const pinsRaw = parsed.value["pins"];
	const pins =
		pinsRaw !== null && typeof pinsRaw === "object" && !Array.isArray(pinsRaw)
			? (pinsRaw as Record<string, unknown>)
			: {};
	return { ok: true, config: { home: home as Record<string, unknown>, pins } };
}

export async function openWorkspace(
	arg: string | undefined,
	ctx: Ctx,
): Promise<{ dir: string; config: WorkspaceConfig }> {
	let ref = arg?.trim() || undefined;
	if (!ref) {
		if (!isTty()) {
			throw new Stop([
				"No workspace given and no terminal to ask on.",
				"Usage: bunx routeros-muse <path-or-git-url>",
			]);
		}
		const answer = await ask("Network workspace (local folder or git URL)?");
		if (!answer) {
			throw new Stop(["No workspace given. Nothing to do."]);
		}
		ref = answer;
	}
	ctx.workspaceLabel = ref;

	let dir: string;
	if (isGitUrl(ref)) {
		console.log(`  git home: ${ref}`);
		dir = await cloneHome(ref, ctx);
	} else {
		dir = path.resolve(process.cwd(), ref);
		if (!nodeFs.existsSync(dir)) {
			throw new Stop([
				`${dir} does not exist.`,
				"For a git home, pass the clone URL; for a synced home, pass the folder.",
			]);
		}
		console.log(`  folder home: ${dir}`);
	}

	const validated = await readAndValidate(dir);
	if (!validated.ok) {
		throw new Stop(validated.reason);
	}
	const type = validated.config.home["type"];
	console.log(
		`  workspace valid (home type: ${typeof type === "string" ? type : "unknown"}, canonical)`,
	);
	return { dir, config: validated.config };
}
