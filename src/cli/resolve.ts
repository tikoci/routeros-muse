// Start workspace resolution (T93): a valid workspace serves; a
// non-workspace on a TTY offers init-here / registry pick / browser
// picker, and off a TTY falls to no-workspace mode. Init and pick
// resolve BEFORE the server binds — there is no live root switch.
import * as nodeFs from "node:fs";
import * as path from "node:path";
import {
	readRegistry,
	registerWorkspace,
	registryEntryAlive,
} from "../lib/registry";
import { CDB_ENCRYPT_STEERING, scaffoldIntoDir } from "../lib/workspace";
import { readAndValidate } from "../steps/workspace";

export type ResolveDeps = {
	isTty: boolean;
	ask: (question: string) => Promise<string | null>;
	print: (line: string) => void;
	registryFile: string;
	env: Record<string, string>;
	templatesRoot?: string | null;
};

export type StartResolution =
	| { kind: "serve"; dir: string }
	| { kind: "no-workspace" }
	| { kind: "abort"; why: string };

export async function resolveStart(
	dir: string,
	deps: ResolveDeps,
): Promise<StartResolution> {
	const validated = await readAndValidate(dir);
	if (validated.ok) return { kind: "serve", dir };
	const hasToml = nodeFs.existsSync(path.join(dir, "workspace.toml"));
	if (hasToml) {
		for (const line of validated.reason) deps.print(line);
	} else {
		deps.print(`not a workspace (no workspace.toml): ${dir}`);
	}
	if (!deps.isTty) {
		deps.print("no terminal to ask on: serving with no workspace attached.");
		return { kind: "no-workspace" };
	}
	deps.print(`Start options for ${dir}:`);
	if (!hasToml) deps.print("  1) init a workspace here");
	deps.print("  2) pick a registered workspace");
	deps.print("  3) open the browser picker (no workspace attached)");
	const answer = (await deps.ask("Choose [1/2/3]:"))?.trim() ?? "";
	if (answer === "1" && !hasToml) {
		const made = await scaffoldIntoDir(dir, deps.env, "minimal", {
			templatesRoot: deps.templatesRoot,
		});
		if (!made.ok) {
			deps.print(made.why);
			return { kind: "abort", why: made.why };
		}
		registerWorkspace(deps.registryFile, path.basename(made.dir), made.dir);
		deps.print(`workspace ready: ${made.dir}`);
		deps.print(CDB_ENCRYPT_STEERING);
		return { kind: "serve", dir: made.dir };
	}
	if (answer === "2") {
		const { entries } = readRegistry(deps.registryFile);
		if (entries.length === 0) {
			const why = "no registered workspaces to pick from.";
			deps.print(why);
			return { kind: "abort", why };
		}
		entries.forEach((e, i) => {
			const alive = registryEntryAlive(e);
			deps.print(
				`  ${i + 1}) ${e.name}${alive ? "" : " (missing)"} — ${e.path}`,
			);
		});
		const pick = (await deps.ask("Workspace number:"))?.trim() ?? "";
		const n = Number(pick);
		const chosen =
			Number.isInteger(n) && n >= 1 && n <= entries.length
				? entries[n - 1]
				: undefined;
		if (!chosen) {
			const why = "no workspace chosen.";
			deps.print(why);
			return { kind: "abort", why };
		}
		if (!registryEntryAlive(chosen)) {
			const why = `not a workspace anymore: ${chosen.path}`;
			deps.print(why);
			return { kind: "abort", why };
		}
		return { kind: "serve", dir: chosen.path };
	}
	if (answer === "3") return { kind: "no-workspace" };
	const why = "no choice made; nothing to serve.";
	deps.print(why);
	return { kind: "abort", why };
}
