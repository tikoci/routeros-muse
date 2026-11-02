#!/usr/bin/env bun
// skill-check.ts — prototype "expected vs loaded" skill check (S2 research).
//
// Compares an expected project-skill name set against what muse actually
// loaded. Two inputs, matching the two surfaces grounded in
// docs/design/skills-surface.md:
//
//   --msp <skills.json>   an MSP `skill/list` result dump (selector+source
//                         only; no path, activation, or errors on the wire)
//   --cli <list.json>     a `muse skills list --json` full-catalog dump
//                         (adds path, activation, and diagnostics)
//
// The expected set must use SKILL.md frontmatter `name` values: the
// frontmatter name wins over the directory name (S6: dir `name-mismatch`
// with `name: frontmatter-name` lists as `frontmatter-name`; a missing
// `name` falls back to the directory name).
//
// Research-only: zero deps, no dependency on src/.
//
// Exit status: 0 when missing/unexpected/errored are all empty, else 1.

export interface MspSkillRow {
	selector: string;
	source: string;
	description?: string;
	displayName?: string;
	pluginId?: string;
}

export interface CliDiag {
	code?: string;
	message?: string;
	path?: string;
	scope?: string;
}

export interface CliSkillRow {
	name: string;
	scope: string;
	activation?: string;
	path?: string;
	diagnostics?: CliDiag[];
}

export interface SkillDiff {
	/** Expected project names with no [project] row (absent, broken, off, or shadowed). */
	missing: string[];
	/** [project] rows nobody expected. */
	unexpected: string[];
}

export interface SkillError {
	name: string;
	path: string;
	message: string;
}

/** Diff expected project names against MSP `skill/list` rows. */
export function compareMspSkills(
	expected: string[],
	rows: MspSkillRow[],
): SkillDiff {
	const want = new Set(expected);
	// Bare project selectors only: plugin rows carry `plugin:skill`
	// qualified spellings that never collide with project names.
	const loaded = new Set(
		rows
			.filter((r) => r.source === "project" && !r.selector.includes(":"))
			.map((r) => r.selector),
	);
	const missing = [...want].filter((n) => !loaded.has(n)).sort();
	const unexpected = [...loaded].filter((n) => !want.has(n)).sort();
	return { missing, unexpected };
}

/**
 * Collect load errors for one scope from a CLI full-catalog dump.
 * MSP rows cannot report errors (broken skills are silently absent),
 * so the `errored` leg needs this surface. Matches top-level
 * diagnostics by scope; falls back to the skill-file path stem.
 */
export function collectCliErrors(
	cli: { skills: CliSkillRow[]; diagnostics: CliDiag[] },
	scope = "project",
): SkillError[] {
	const out: SkillError[] = [];
	for (const d of cli.diagnostics ?? []) {
		if (d.scope && d.scope !== scope) continue;
		const m = /[/\\]([^/\\]+)[/\\]SKILL\.md$/.exec(d.path ?? "");
		out.push({
			name: m?.[1] ?? d.path ?? "?",
			path: d.path ?? "?",
			message: d.message ?? d.code ?? "?",
		});
	}
	for (const r of cli.skills ?? []) {
		if (r.scope !== scope) continue;
		for (const d of r.diagnostics ?? []) {
			out.push({
				name: r.name,
				path: r.path ?? "?",
				message: d.message ?? d.code ?? "?",
			});
		}
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function readExpected(spec: string): Promise<string[]> {
	if (spec.includes("\n") || spec.includes(",")) {
		return spec
			.split(/[,\n]/)
			.map((s) => s.trim())
			.filter(Boolean);
	}
	try {
		const f = Bun.file(spec);
		if (await f.exists()) {
			const text = await f.text();
			return text
				.split("\n")
				.map((s) => s.trim())
				.filter((s) => s && !s.startsWith("#"));
		}
	} catch {
		// fall through to single-name treatment
	}
	return [spec];
}

async function main(argv: string[]): Promise<void> {
	const flags = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] as string;
		if (a.startsWith("--") && i + 1 < argv.length) {
			flags.set(a.slice(2), argv[++i] as string);
		}
	}
	const expectedSpec = flags.get("expected");
	const mspPath = flags.get("msp");
	if (!expectedSpec || !mspPath) {
		console.error(
			"usage: skill-check.ts --expected <csv|file> --msp <skill-list.json> [--cli <skills-list.json>]",
		);
		process.exit(2);
	}
	const expected = await readExpected(expectedSpec);
	const msp = (await Bun.file(mspPath).json()) as {
		skills: MspSkillRow[];
	};
	const diff = compareMspSkills(expected, msp.skills ?? []);
	console.log(
		`msp: expected=${expected.length} loaded-project=${(msp.skills ?? []).filter((r) => r.source === "project").length}`,
	);
	console.log(
		`missing (${diff.missing.length}): ${diff.missing.join(" ") || "-"}`,
	);
	console.log(
		`unexpected (${diff.unexpected.length}): ${diff.unexpected.join(" ") || "-"}`,
	);
	let errored: SkillError[] = [];
	const cliPath = flags.get("cli");
	if (cliPath) {
		const cli = (await Bun.file(cliPath).json()) as {
			skills: CliSkillRow[];
			diagnostics: CliDiag[];
		};
		errored = collectCliErrors(cli);
		console.log(`errored (${errored.length}):`);
		for (const e of errored) {
			console.log(`  - ${e.name} [${e.path}] ${e.message}`);
		}
	} else {
		console.log("errored: (no --cli dump; MSP rows cannot report errors)");
	}
	if (diff.missing.length || diff.unexpected.length || errored.length) {
		process.exit(1);
	}
}

if (import.meta.main) await main(process.argv.slice(2));
