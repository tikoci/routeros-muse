// Init command (T93, T133): scaffold a template into dir (default:
// cwd) with an encrypted device.cdb, then register the workspace.
// The picker's create-at-default path (~/Networks) is unchanged.
import * as path from "node:path";
import { decideCdb, decideTemplate, type SecretAsk } from "../lib/cdbSetup";
import { registerWorkspace } from "../lib/registry";
import { scaffoldIntoDir } from "../lib/workspace";

export type InitDeps = {
	print: (line: string) => void;
	isTty: boolean;
	ask: (question: string) => Promise<string | null>;
	askSecret: SecretAsk;
	readStdinPassword: () => Promise<string | null>;
	registryFile: string;
	env: Record<string, string>;
	templatesRoot?: string | null;
};

export type InitOpts = {
	template?: string;
	passwordStdin: boolean;
	openCdb: boolean;
};

export type InitResult = { ok: true; dir: string } | { ok: false; why: string };

export async function runInit(
	dir: string,
	opts: InitOpts,
	deps: InitDeps,
): Promise<InitResult> {
	const tpl = await decideTemplate({
		given: opts.template,
		isTty: deps.isTty,
		ask: deps.ask,
		print: deps.print,
		templatesRoot: deps.templatesRoot,
	});
	if (!tpl.ok) {
		deps.print(tpl.why);
		return { ok: false, why: tpl.why };
	}
	const cdb = await decideCdb({
		passwordStdin: opts.passwordStdin,
		openCdb: opts.openCdb,
		isTty: deps.isTty,
		askSecret: deps.askSecret,
		readStdinPassword: deps.readStdinPassword,
		print: deps.print,
	});
	if (cdb.kind === "abort") {
		deps.print(cdb.why);
		return { ok: false, why: cdb.why };
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
		return { ok: false, why: made.why };
	}
	registerWorkspace(
		deps.registryFile,
		path.basename(path.resolve(made.dir)),
		made.dir,
	);
	const cdbNote = cdb.kind === "encrypted" ? "encrypted" : "OPEN (dev escape)";
	deps.print(
		`workspace ready: ${made.dir} (template: ${tpl.template}, device.cdb: ${cdbNote})`,
	);
	deps.print(`next: routeros-muse start "${made.dir}"`);
	return { ok: true, dir: made.dir };
}
