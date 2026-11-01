// Init command (T93): scaffold a template into dir (default: cwd),
// never overwriting, then register the workspace. The picker's
// create-at-default path (~/Networks) is unchanged.
import * as path from "node:path";
import { registerWorkspace } from "../lib/registry";
import { CDB_ENCRYPT_STEERING, scaffoldIntoDir } from "../lib/workspace";

export type InitDeps = {
	print: (line: string) => void;
	registryFile: string;
	env: Record<string, string>;
	templatesRoot?: string | null;
};

export type InitResult = { ok: true; dir: string } | { ok: false; why: string };

export async function runInit(
	dir: string,
	template: string,
	deps: InitDeps,
): Promise<InitResult> {
	const made = await scaffoldIntoDir(dir, deps.env, template, {
		templatesRoot: deps.templatesRoot,
	});
	if (!made.ok) {
		deps.print(made.why);
		return { ok: false, why: made.why };
	}
	registerWorkspace(
		deps.registryFile,
		path.basename(path.resolve(made.dir)),
		made.dir,
	);
	deps.print(`workspace ready: ${made.dir} (template: ${template})`);
	deps.print(CDB_ENCRYPT_STEERING);
	deps.print(`next: routeros-muse start "${made.dir}"`);
	return { ok: true, dir: made.dir };
}
