// T94 shared temp-dir registry: every test mkdtemp goes through mktmp,
// and every test file ends with afterAll(cleanupTmpdirs). tools/ui-smoke.ts
// (a plain script, no afterAll) calls cleanupTmpdirs() in its top-level
// finally instead. Bun shares module instances across test files and runs
// them sequentially, so one global list is safe; cleanup drains it, so a
// file's afterAll also heals any earlier file that forgot to wire one.
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpdirs: string[] = [];

export function mktmp(prefix: string): string {
	const d = nodeFs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpdirs.push(d);
	return d;
}

/** Track a dir created outside mktmp (a server-owned path) for cleanup. */
export function trackTmp(dir: string): string {
	tmpdirs.push(dir);
	return dir;
}

export function cleanupTmpdirs(): void {
	for (const d of tmpdirs.splice(0)) {
		nodeFs.rmSync(d, { recursive: true, force: true });
	}
}
