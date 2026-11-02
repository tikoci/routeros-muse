#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// check-skills.ts — skill gate: shape + playbook + tested-references.
// Mirrors routeros-skills scripts/check-skills.ts, then goes further:
//   shape:    YAML frontmatter present; `name` + `description` non-empty;
//             `name` equals the skill directory; name <= 64, desc <= 1024
//             chars (Anthropic skill-spec limits); an H1 follows frontmatter.
//   playbook: unless frontmatter says `playbook: false`, the doc carries
//             a `## Part 1` checklist with >= 3 numbered steps plus the 8
//             recipe sections (Trigger/Prereqs/Access/Envs/Outputs/
//             Verification/Recovery/Limits). Guardrails and guides opt out
//             explicitly — silence is not an exemption.
//   tested:   any code file under `references/` (*.sh *.ts *.js *.py
//             *.yaml *.yml *.rsc) requires an executable `references/test.sh`
//             entrypoint, which the gate RUNS (60s budget). Untested code
//             fails the gate; docs (*.md) need no entrypoint.
//   meta:     `topics:` required (flow list, vocab-checked against
//             tools/skill-topics.txt); `requires:` optional flow list from
//             twin|container|disk|git|production-ok; `tested:` required
//             (none|self-test|twin-run); self-test+ requires a passing
//             test.sh; twin-run additionally requires references/twin-run.md
//             citing machine + date.
// Usage: bun tools/check-skills.ts [skills-root]   (default templates/network/.agents/skills)
// Exit: 0 all green, 1 any failure. Zero deps; Bun only.
import { Glob } from "bun";

const NAME_MAX = 64;
const DESC_MAX = 1024;
const MIN_STEPS = 3;
const TEST_BUDGET_MS = 60000;
const K22 = [
	"Trigger",
	"Prereqs",
	"Access",
	"Envs",
	"Outputs",
	"Verification",
	"Recovery",
	"Limits",
];
const CODE_EXTS = [".sh", ".ts", ".js", ".py", ".yaml", ".yml", ".rsc"];
const REQUIRES_ENUM = ["twin", "container", "disk", "git", "production-ok"];
const TESTED_ENUM = ["none", "self-test", "twin-run"];
const HERE =
	typeof import.meta.dir === "string" && import.meta.dir.length > 0
		? import.meta.dir
		: dirname(fileURLToPath(import.meta.url));

let vocabCache: Set<string> | null = null;
export function loadVocab(): Set<string> {
	if (vocabCache) return vocabCache;
	vocabCache = new Set(
		readFileSync(join(HERE, "skill-topics.txt"), "utf8")
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.startsWith("#")),
	);
	return vocabCache;
}

const unquote = (v: string): string =>
	v.trim().replace(/^(['"])([\s\S]*)\1$/, "$2");

export function splitFrontmatter(
	text: string,
): { front: string; body: string } | null {
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!m) return null;
	return { front: m[1] ?? "", body: text.slice(m[0].length) };
}

export function frontVal(front: string, key: string): string | null {
	const m = front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
	return m ? unquote(m[1] ?? "") : null;
}

export function verifyShape(dir: string, text: string): string[] {
	const problems: string[] = [];
	const split = splitFrontmatter(text);
	if (!split) return ["missing or malformed YAML frontmatter (--- ... ---)"];
	const name = frontVal(split.front, "name");
	const desc = frontVal(split.front, "description");
	if (name === null) problems.push("frontmatter missing `name:`");
	if (desc === null) problems.push("frontmatter missing `description:`");
	if (name !== null) {
		if (name !== dir)
			problems.push(`name "${name}" does not match directory "${dir}"`);
		if (name.length > NAME_MAX)
			problems.push(`name is ${name.length} chars (max ${NAME_MAX})`);
	}
	if (desc !== null) {
		if (desc.length === 0) problems.push("description is empty");
		if (desc.length > DESC_MAX)
			problems.push(`description is ${desc.length} chars (max ${DESC_MAX})`);
	}
	const firstLine =
		split.body.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
	if (!firstLine.startsWith("# ")) {
		problems.push(
			`expected an H1 ("# ...") after frontmatter, found: ${firstLine.slice(0, 60) || "(empty)"}`,
		);
	}
	return problems;
}

export function isPlaybookSkill(front: string): boolean {
	return frontVal(front, "playbook") !== "false";
}

function part1Section(body: string): string | null {
	const lines = body.split(/\r?\n/);
	const start = lines.findIndex((l) => /^## Part 1\b/.test(l));
	if (start < 0) return null;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^## /.test(lines[i] ?? "")) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end).join("\n");
}

export function verifyPlaybook(text: string): string[] {
	const problems: string[] = [];
	const split = splitFrontmatter(text);
	if (!split) return ["missing frontmatter (shape gate reports this too)"];
	if (!isPlaybookSkill(split.front)) return [];
	const part1 = part1Section(split.body);
	if (part1 === null) {
		problems.push(
			"playbook skill without `## Part 1` checklist (or opt out via `playbook: false`)",
		);
	} else {
		const steps = part1.split(/\r?\n/).filter((l) => /^\d+\.\s+\S/.test(l));
		if (steps.length < MIN_STEPS)
			problems.push(
				`Part 1 has ${steps.length} numbered steps (min ${MIN_STEPS})`,
			);
	}
	for (const h of K22) {
		if (!new RegExp(`^###\\s+${h}\\s*$`, "m").test(split.body))
			problems.push(`missing recipe section \`### ${h}\``);
	}
	return problems;
}

export interface RefsStatus {
	codeFiles: string[];
	hasTest: boolean;
	testExecutable: boolean;
}

export function refsStatus(skillDir: string): RefsStatus | null {
	const refs = join(skillDir, "references");
	if (!existsSync(refs) || !statSync(refs).isDirectory()) return null;
	const entries = readdirSync(refs);
	const codeFiles = entries
		.filter((e) => CODE_EXTS.some((x) => e.endsWith(x)))
		.sort();
	const hasTest = entries.includes("test.sh");
	const testExecutable =
		hasTest && (statSync(join(refs, "test.sh")).mode & 0o111) !== 0;
	return { codeFiles, hasTest, testExecutable };
}

export function parseFlowList(raw: string): string[] | null {
	const t = raw.trim();
	if (!t.startsWith("[") || !t.endsWith("]")) return null;
	const inner = t.slice(1, -1).trim();
	if (inner === "") return [];
	return inner
		.split(",")
		.map((s) => unquote(s.trim()))
		.filter((s) => s.length > 0);
}

export function verifyMeta(_dir: string, front: string): string[] {
	const problems: string[] = [];
	const tm = front.match(/^topics:\s*(.*)$/m);
	if (!tm) {
		problems.push(
			"frontmatter missing `topics:` (flow list, e.g. topics: [git, sync])",
		);
	} else {
		const vals = parseFlowList(tm[1] ?? "");
		if (vals === null)
			problems.push("`topics:` must be a one-line flow list like [git, sync]");
		else if (vals.length === 0)
			problems.push("`topics:` needs at least one topic");
		else {
			const vocab = loadVocab();
			for (const v of vals) {
				if (!vocab.has(v))
					problems.push(
						`unknown topic "${v}" (add to tools/skill-topics.txt or fix)`,
					);
			}
		}
	}
	const rm = front.match(/^requires:\s*(.*)$/m);
	if (rm) {
		const vals = parseFlowList(rm[1] ?? "");
		if (vals === null)
			problems.push(
				"`requires:` must be a one-line flow list like [twin] (or omit)",
			);
		else
			for (const v of vals) {
				if (!REQUIRES_ENUM.includes(v))
					problems.push(
						`unknown requires "${v}" (one of ${REQUIRES_ENUM.join("|")})`,
					);
			}
	}
	const tv = frontVal(front, "tested");
	if (tv === null)
		problems.push("frontmatter missing `tested:` (none|self-test|twin-run)");
	else if (!TESTED_ENUM.includes(tv))
		problems.push(`tested: "${tv}" must be one of ${TESTED_ENUM.join("|")}`);
	return problems;
}

export function verifyTested(skillDir: string, front: string): string[] {
	const tv = frontVal(front, "tested");
	if (tv !== "self-test" && tv !== "twin-run") return [];
	const st = refsStatus(skillDir);
	if (!st?.hasTest) return ["tested: self-test+ requires references/test.sh"];
	if (!st.testExecutable) return ["references/test.sh is not executable"];
	if (tv === "twin-run") {
		const p = join(skillDir, "references", "twin-run.md");
		if (!existsSync(p))
			return [
				"tested: twin-run requires references/twin-run.md (machine + date + command)",
			];
		const body = readFileSync(p, "utf8");
		if (!/\d{4}-\d{2}-\d{2}/.test(body))
			return ["twin-run.md must cite a date (YYYY-MM-DD)"];
		if (!/twin|chr|hardware|routeros/i.test(body))
			return ["twin-run.md must name the proof target"];
	}
	return [];
}

export function verifyRefs(skillDir: string): string[] {
	const st = refsStatus(skillDir);
	if (st === null || (st.codeFiles.length === 0 && !st.hasTest)) return [];
	if (!st.hasTest)
		return [
			`references/ holds code (${st.codeFiles.join(", ")}) with no test.sh entrypoint`,
		];
	if (!st.testExecutable) return ["references/test.sh is not executable"];
	return [];
}

export async function runSkillTest(
	skillDir: string,
): Promise<{ ok: boolean; output: string }> {
	const refs = join(skillDir, "references");
	const proc = Bun.spawn(["./test.sh"], {
		cwd: refs,
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => {
		try {
			proc.kill();
		} catch {
			/* already exited */
		}
	}, TEST_BUDGET_MS);
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	const output = (out + err).trim();
	if (code !== 0) return { ok: false, output: output || `exit ${code}` };
	return { ok: true, output };
}

export async function verifySkill(
	skillsRoot: string,
	dir: string,
): Promise<string[]> {
	const skillDir = join(skillsRoot, dir);
	const problems: string[] = [];
	let text: string;
	try {
		text = await Bun.file(join(skillDir, "SKILL.md")).text();
	} catch {
		return [`${dir}/SKILL.md missing or unreadable`];
	}
	problems.push(...verifyShape(dir, text).map((p) => `${dir}: ${p}`));
	const split = splitFrontmatter(text);
	if (split) {
		problems.push(...verifyPlaybook(text).map((p) => `${dir}: ${p}`));
		problems.push(...verifyMeta(dir, split.front).map((p) => `${dir}: ${p}`));
		problems.push(
			...verifyTested(skillDir, split.front).map((p) => `${dir}: ${p}`),
		);
	}
	problems.push(...verifyRefs(skillDir).map((p) => `${dir}: ${p}`));
	const st = refsStatus(skillDir);
	if (st?.hasTest && st.testExecutable && problems.length === 0) {
		const r = await runSkillTest(skillDir);
		if (!r.ok) problems.push(`${dir}: references/test.sh failed:\n${r.output}`);
	}
	return problems;
}

if (import.meta.main) {
	const root = process.argv[2] ?? "templates/network/.agents/skills";
	const files = (
		await Array.fromAsync(
			new Glob("*/SKILL.md").scan({ cwd: root, onlyFiles: true }),
		)
	).sort();
	if (files.length === 0) {
		console.error(`✗ no */SKILL.md under ${root} — pass the skills root`);
		process.exit(1);
	}
	let failures = 0;
	let tested = 0;
	for (const f of files) {
		const seg = f.split("/")[0] ?? f;
		const dir = basename(f.slice(0, -"/SKILL.md".length)) || seg;
		const problems = await verifySkill(root, dir);
		if (problems.length > 0) {
			failures += problems.length;
			for (const p of problems) console.error(`✗ ${p}`);
		} else {
			const st = refsStatus(join(root, dir));
			const tag = st?.hasTest ? " (+references test passed)" : "";
			if (st?.hasTest) tested++;
			console.log(`✓ ${dir} valid${tag}`);
		}
	}
	if (failures > 0) {
		console.error(`\n${failures} skill validation error(s)`);
		process.exit(1);
	}
	console.log(
		`\n✓ ${files.length} skills valid (${tested} with passing references tests)`,
	);
}
