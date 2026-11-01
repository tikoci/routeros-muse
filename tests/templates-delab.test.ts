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
			const lines = nodeFs.readFileSync(f, "utf8").split("\n");
			lines.forEach((line, i) => {
				for (const re of DENY) {
					if (re.test(line)) {
						hits.push(
							`${path.relative(root, f)}:${i + 1}: ${line.trim().slice(0, 100)}`,
						);
						break;
					}
				}
			});
		}
		expect(hits).toEqual([]);
	});
});
