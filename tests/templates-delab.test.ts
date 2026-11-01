// T96: the shipped templates must not name the pilot lab. Router
// names, the build machine, agent-habitat jargon, lab subnets, and
// private-archive pointers would dangle (or leak) in a user's
// workspace, so this guard fails on any of them under templates/.
// Hermetic: pure file reads, no temp dirs, no network.
import { describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { templatesRoot } from "../src/lib/templates";

// Case-insensitive: the pilot grep was case-sensitive and missed
// "Bigdude-class" and "Habitat".
const DENY: RegExp[] = [
	/bigdude/i,
	/scz-/i,
	/orca/i,
	/habitat/i,
	/~\/Work/,
	/Work\/notes/,
	/orca-setup/,
	/172\.22\.74/,
	/192\.168\.74/,
];

// T96 follow-up: residue the first regex missed. The forum topic id,
// private project/deployment names, and parenthetical tracker IDs
// apply to every file: a .toml fixture names the private project
// and the .gitignores carry tracker parentheticals.
const DENY_MORE: RegExp[] = [
	/181789/,
	/heltec-victron|victron-heltec/i,
	/ginny-pig/i,
	// Parenthetical tracker IDs; "(T3 Code ...)"/"(T3 Connect ...)" are
	// the product, not a tracker reference.
	/\((?!T3\s+(?:Code|Connect)\b)T\d+\b/,
	// A source label, including in JSON fixture comments.
	/owner-presentation/i,
];

// Citation forms, the retired coord room/CLI, and the standing-pair
// wording are markdown-only: test.sh fixtures use `coord` as a
// coordinate variable, which must keep passing.
const DENY_MD: RegExp[] = [
	/(homework|feedback|codex)\s*§/i,
	/\((homework|feedback|codex)\b/i,
	/demo catalog/i,
	/Coding Agent Feedback/,
	/demo-hardware-notes/i,
	/showing-the-owner/i,
	/concept[-\s]+review\s*§/i,
	/\bcoord\b/i,
	/standing pair/i,
];

// Strings that must NEVER match: private IPs, key shapes, bare
// tracker ids, the T3 Code product name, in-skill vocabularies,
// and ordinary words containing "coord". If a DENY pattern starts
// matching one of these, the pattern (not the allow-case) is wrong.
const ALLOW: string[] = [
	"192.168.1.20",
	"10.0.0.0/8",
	"private-key material stays redacted",
	"bare T40 and T9 references without parens",
	"T3 Code desktop",
	"T3 Connect MCP",
	"(T3 Code desktop)",
	"(T3 Connect MCP)",
	"cells S1/S2/C2/B2/B3",
	"validator rules S1-S6",
	"R0-R8 and P0-P9 probes",
	"UM matrix cell",
	"coordination, not a lock",
	"the fleet coordinator",
	"coordinates match the records",
	"null-island coords",
	"coordinate-relative",
	"Full Victron stack rejected on cost",
	"feedback on the live design",
	"collected: an earlier review",
	"from pilot feedback",
	"from an earlier field run",
];

// Strings that MUST match: residue shapes earlier patterns missed
// (a JSON source label; a citation wrapped across lines).
const MUST_DENY: string[] = [
	'{"_comment":"shape per site (owner-presentation rules)."}',
	"see concept\nreview §7 for the loop",
	"(T40) workspace shape",
];

function allFiles(dir: string): string[] {
	const out: string[] = [];
	for (const e of nodeFs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...allFiles(p));
		else if (e.isFile()) out.push(p);
	}
	return out.sort();
}

describe("shipped templates carry no pilot-lab residue", () => {
	test("no file under templates/ matches the lab denylist", () => {
		const root = templatesRoot();
		if (!root) throw new Error("templates root missing under test");
		const hits: string[] = [];
		for (const f of allFiles(root)) {
			// presentation-layer is owned by another branch; it skips
			// the markdown-only patterns until that branch lands.
			const ownMD = f.endsWith(".md") && !f.includes("presentation-layer");
			const more = f.includes("presentation-layer")
				? DENY_MORE.filter((re) => !re.test("owner-presentation"))
				: DENY_MORE;
			const deny = ownMD ? [...DENY, ...more, ...DENY_MD] : [...DENY, ...more];
			// Whole-file matching so a citation wrapped across lines is
			// still caught; the line number comes from the match index.
			const text = nodeFs.readFileSync(f, "utf8");
			for (const re of deny) {
				const m = re.exec(text);
				if (!m) continue;
				const lineNo = text.slice(0, m.index).split("\n").length;
				const line = text.split("\n")[lineNo - 1] ?? "";
				hits.push(
					`${path.relative(root, f)}:${lineNo}: ${line.trim().slice(0, 100)}`,
				);
			}
		}
		expect(hits).toEqual([]);
	});
	test("denylist still catches known residue shapes", () => {
		const missed = MUST_DENY.filter(
			(sample) =>
				![...DENY, ...DENY_MORE, ...DENY_MD].some((re) => re.test(sample)),
		);
		expect(missed).toEqual([]);
	});
	test("denylist stays tight: allow-cases never match", () => {
		const bad: string[] = [];
		for (const sample of ALLOW) {
			for (const re of [...DENY, ...DENY_MORE, ...DENY_MD]) {
				if (re.test(sample)) bad.push(`${re}: ${sample}`);
			}
		}
		expect(bad).toEqual([]);
	});
});
