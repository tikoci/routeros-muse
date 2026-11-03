// Start workspace resolution (T93, T133): a valid workspace serves;
// a non-workspace on a TTY offers init-here / pick / browser
// picker; off a TTY the cwd default falls to no-workspace mode while
// an explicitly named dir aborts. Init and pick
// resolve BEFORE the server binds — there is no live root switch.
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { decideCdb, decideTemplate, type SecretAsk } from "../lib/cdbSetup";
import {
	readRegistry,
	registerWorkspace,
	registryEntryAlive,
} from "../lib/registry";
import { scaffoldIntoDir } from "../lib/workspace";
import { readAndValidate } from "../steps/workspace";

export type ResolveDeps = {
	isTty: boolean;
	ask: (question: string) => Promise<string | null>;
	askSecret: SecretAsk;
	readStdinPassword: () => Promise<string | null>;
	print: (line: string) => void;
	registryFile: string;
	env: Record<string, string>;
	templatesRoot?: string | null;
	/** The dir was named on the command line (not the cwd default). */
	explicit?: boolean;
	/** T133: start option 1 scaffold template (undefined prompts). */
	template?: string;
	/** T133: option 1 reads the new CDB password from stdin. */
	passwordStdin: boolean;
	/** T133: option 1 creates with an open CDB (dev escape). */
	openCdb: boolean;
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
		if (deps.explicit) {
			// A named dir is a request for THAT workspace: never swap
			// to no-workspace mode (operator CDB, cwd root) behind it.
			const why = `not serving ${dir}: create it with \`routeros-muse init ${dir}\`, or run start with no dir for the picker.`;
			deps.print(why);
			return { kind: "abort", why };
		}
		deps.print("no terminal to ask on: serving with no workspace attached.");
		return { kind: "no-workspace" };
	}
	deps.print(`Start options for ${dir}:`);
	if (!hasToml) deps.print("  1) init a workspace here (created encrypted)");
	deps.print("  2) pick a registered workspace");
	deps.print("  3) open the browser picker (no workspace attached)");
	const answer = (await deps.ask("Choose [1/2/3]:"))?.trim() ?? "";
	if (answer === "1" && !hasToml) {
		const tpl = await decideTemplate({
			given: deps.template,
			isTty: true,
			ask: deps.ask,
			print: deps.print,
			templatesRoot: deps.templatesRoot,
		});
		if (!tpl.ok) {
			deps.print(tpl.why);
			return { kind: "abort", why: tpl.why };
		}
		const cdb = await decideCdb({
			passwordStdin: deps.passwordStdin,
			openCdb: deps.openCdb,
			isTty: true,
			askSecret: deps.askSecret,
			readStdinPassword: deps.readStdinPassword,
			print: deps.print,
		});
		if (cdb.kind === "abort") {
			deps.print(cdb.why);
			return { kind: "abort", why: cdb.why };
		}
		const made = await scaffoldIntoDir(dir, deps.env, tpl.template, {
			templatesRoot: deps.templatesRoot,
			cdb:
				cdb.kind === "encrypted"
					? { kind: "encrypted", password: cdb.password }
					: { kind: "open" },
		});
		if (!made.ok) {
			deps.print(made.why);
			return { kind: "abort", why: made.why };
		}
		registerWorkspace(deps.registryFile, path.basename(made.dir), made.dir);
		const cdbNote =
			cdb.kind === "encrypted" ? "encrypted" : "OPEN (dev escape)";
		deps.print(`workspace ready: ${made.dir} (device.cdb: ${cdbNote})`);
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
