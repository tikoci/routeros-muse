#!/usr/bin/env bun
// T94 gate check: fail if a gate run leaves anything in its fresh TMPDIR.
//
// Usage: bun tools/check-tmpdir.ts <dir>
// Exit 0 when the dir holds nothing but allow-listed third-party paths,
// else list the leftovers and exit 1. Runs from `make gate`, never from
// inside a test.
import * as nodeFs from "node:fs";
import * as path from "node:path";

// Exact third-party names that unavoidably write into TMPDIR, with a why.
// None known yet: add entries only for paths this repo cannot clean
// itself (bun's own cache, playwright, muse), never a broad glob.
const ALLOW: string[] = [];

const dir = process.argv[2];
if (!dir) {
	console.error("usage: bun tools/check-tmpdir.ts <dir>");
	process.exit(2);
}

let entries: string[];
try {
	entries = nodeFs.readdirSync(dir);
} catch (err) {
	console.error(
		`check-tmpdir: cannot read ${dir}: ${err instanceof Error ? err.message : String(err)}`,
	);
	process.exit(2);
}

const leftovers = entries.filter((e) => !ALLOW.includes(e)).sort();
if (leftovers.length === 0) {
	console.log(`tmpdir clean: ${dir} empty`);
	process.exit(0);
}

console.log(`tmpdir leaks: ${leftovers.length} leftover(s) in ${dir}:`);
for (const name of leftovers.slice(0, 60)) {
	let extra = "";
	try {
		const full = path.join(dir, name);
		const st = nodeFs.statSync(full);
		if (st.isDirectory()) {
			extra = ` (dir, ${nodeFs.readdirSync(full).length} entries)`;
		} else {
			extra = ` (file, ${st.size} bytes)`;
		}
	} catch {
		extra = " (unstatable)";
	}
	console.log(`  ${name}${extra}`);
}
if (leftovers.length > 60) {
	console.log(`  ... and ${leftovers.length - 60} more`);
}
process.exit(1);
