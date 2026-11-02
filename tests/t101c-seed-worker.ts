// T101 round 3: one side of the two-process seed race. Run as
// `bun tests/t101c-seed-worker.ts <configHome> <workspaceRoot> <role>
// <coordDir> [host...]` (role "a" or "b"). Seeds its own workspace
// root + hosts, forcing the interleave through the rename seam:
// both workers must reach the rename before either commits, so
// without the cross-process lock one rename clobbers the other,
// while with the lock the loser waits and merges instead.
//
// The waits are bounded (never hangs the suite): the arrival gate
// proves both sides entered together, and the rename wait expires
// when the peer is legitimately queued on the lock.
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { ensurePreallowReads } from "../src/lib/preallow";

const [configHome, workspaceRoot, role, coordDir, ...hosts] = Bun.argv.slice(2);
if (!configHome || !workspaceRoot || !role || !coordDir) {
	console.error(
		"usage: t101c-seed-worker.ts <configHome> <ws> <role> <coord> [host...]",
	);
	process.exit(2);
}
const peer = role === "a" ? "b" : "a";

function waitFor(file: string, timeoutMs: number): void {
	const deadline = Date.now() + timeoutMs;
	while (!nodeFs.existsSync(file)) {
		if (Date.now() > deadline) return;
		Bun.sleepSync(10);
	}
}

// Arrival gate: both sides enter the seed together.
nodeFs.writeFileSync(path.join(coordDir, `arrived-${role}`), "here\n");
waitFor(path.join(coordDir, `arrived-${peer}`), 15_000);

const res = ensurePreallowReads(
	{ configHome, workspaceRoot, hosts, enabled: true },
	{
		renameSync: (tmp, file) => {
			nodeFs.writeFileSync(path.join(coordDir, `ready-${role}`), "ready\n");
			// Pre-fix both sides reach this wait (neither has
			// renamed yet, so both rereads matched) and then both
			// rename: last writer wins, the other side's rules are
			// lost. Post-fix the lock holder waits out the peer,
			// commits, and releases; the peer then merges over the
			// committed bytes. The wait must stay well under the
			// lock-acquire bound (10s default).
			waitFor(path.join(coordDir, `ready-${peer}`), 3_000);
			Bun.sleepSync(200);
			nodeFs.renameSync(tmp, file);
		},
	},
);
console.log(
	JSON.stringify({ role, changed: res.changed, warnings: res.warnings }),
);
