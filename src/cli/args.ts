// Owner CLI parsing (T93, D35): start|serve, init, code, doctor.
// Bare argv is start. Pure (Stop on errors, never exits) so tests
// drive every command, flag, and passthrough rule directly.
import { Stop } from "../lib/stop";
import { listTemplates } from "../lib/templates";

export function usage(): string[] {
	return [
		"routeros-muse — an agent beside your network",
		"",
		"Usage: routeros-muse [command] [dir] [options]",
		"",
		"  (bare)        start the web UI (same as start)",
		"  start [dir]   serve the workspace, open the browser (alias: serve)",
		"  init [dir]    scaffold a workspace here (default: this directory)",
		"  code [dir]    check the machine, then exec muse in the workspace",
		"  doctor [dir]  print-only checks; exit 1 when a required item is missing",
		"",
		"  start: --port N, --host H, --no-open, --yolo, --tui (= code)",
		"  init: --template minimal|network (default: minimal), --password-stdin, --open-cdb",
		"  code: --yes, --router H[:port], --print-only; the rest passes to muse (-- ends our flags)",
		"",
		"New workspaces are created encrypted: init and start option 1",
		"prompt for a CDB password on a TTY, or take it from --password-stdin.",
		"--open-cdb creates without encryption (dev escape, never the default).",
		"",
		"Start option 1 also takes --template, --password-stdin, --open-cdb.",
		"",
		"Developer flags (start): --no-workspace, --provider NAME, --allow-open-cdb, --no-trust-workspace",
		"",
		"  --help, -h     this help",
		"  --version, -V  print version",
	];
}

export type StartOpts = {
	dir?: string;
	port?: number;
	host?: string;
	noOpen: boolean;
	yolo: boolean;
	noWorkspace?: boolean;
	provider?: string;
	allowOpenCdb?: boolean;
	/** D39: spawn the worker without --trust-workspace (skills stay unloaded). */
	noTrustWorkspace?: boolean;
	/** T133: start option 1 scaffold template (undefined prompts on a TTY). */
	template?: string;
	/** T133: read the new CDB password from stdin (else prompt or abort). */
	passwordStdin: boolean;
	/** T133: create the new workspace with an open CDB (dev escape). */
	openCdb: boolean;
};

export type InitOpts = {
	dir?: string;
	/** Flag-given template (undefined prompts on a TTY, defaults off a TTY). */
	template?: string;
	/** T133: read the new CDB password from stdin (else prompt or abort). */
	passwordStdin: boolean;
	/** T133: create the workspace with an open CDB (dev escape). */
	openCdb: boolean;
};

export type CodeOpts = {
	dir?: string;
	yes: boolean;
	router?: string;
	printOnly: boolean;
	passthrough: string[];
};

export type DoctorOpts = { dir?: string };

export type Parsed =
	| { cmd: "start"; opts: StartOpts }
	| { cmd: "init"; opts: InitOpts }
	| { cmd: "code"; opts: CodeOpts }
	| { cmd: "doctor"; opts: DoctorOpts };

export type ParseDeps = {
	/** Known template names (tests inject; defaults to the disk list). */
	knownTemplates?: string[];
};

function knownTemplateNames(deps?: ParseDeps): string[] {
	return deps?.knownTemplates ?? listTemplates().map((t) => t.name);
}

function parsePort(flag: string, value: string | undefined): number {
	const v = Number(value);
	if (value === undefined || !Number.isInteger(v) || v < 0 || v > 65535) {
		throw new Stop([`${flag} needs a number 0-65535.`, ...usage()]);
	}
	return v;
}

function onlyOneDir(positional: string[], cmd: string): string | undefined {
	if (positional.length > 1) {
		throw new Stop([`${cmd} takes at most one directory.`, ...usage()]);
	}
	return positional[0];
}

function parseStartArgs(argv: string[], deps?: ParseDeps): StartOpts {
	const opts: StartOpts = {
		noOpen: false,
		yolo: false,
		passwordStdin: false,
		openCdb: false,
	};
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === undefined) continue;
		if (a === "--help" || a === "-h") throw new HelpRequest();
		if (a === "--version" || a === "-V") throw new VersionRequest();
		if (a === "--port") {
			opts.port = parsePort("--port", argv[++i]);
		} else if (a === "--host") {
			const v = argv[++i];
			if (!v) throw new Stop(["--host needs an address.", ...usage()]);
			opts.host = v;
		} else if (a === "--provider") {
			const v = argv[++i];
			if (!v) throw new Stop(["--provider needs a name.", ...usage()]);
			opts.provider = v;
		} else if (a === "--template") {
			const v = argv[++i];
			if (!v) throw new Stop(["--template needs a name.", ...usage()]);
			opts.template = v;
		} else if (a === "--password-stdin") {
			opts.passwordStdin = true;
		} else if (a === "--open-cdb") {
			opts.openCdb = true;
		} else if (a === "--no-open") {
			opts.noOpen = true;
		} else if (a === "--yolo") {
			opts.yolo = true;
		} else if (a === "--no-workspace") {
			opts.noWorkspace = true;
		} else if (a === "--allow-open-cdb") {
			opts.allowOpenCdb = true;
		} else if (a === "--no-trust-workspace") {
			opts.noTrustWorkspace = true;
		} else if (a.startsWith("-")) {
			throw new Stop([`Unknown start flag: ${a}`, ...usage()]);
		} else {
			positional.push(a);
		}
	}
	opts.dir = onlyOneDir(positional, "start");
	if (opts.noWorkspace && opts.dir !== undefined) {
		throw new Stop(["--no-workspace takes no directory argument.", ...usage()]);
	}
	if (
		opts.template !== undefined &&
		!knownTemplateNames(deps).includes(opts.template)
	) {
		throw new Stop([
			`Unknown template: ${opts.template} (have: ${knownTemplateNames(deps).join(", ") || "none"}).`,
			...usage(),
		]);
	}
	if (opts.passwordStdin && opts.openCdb) {
		throw new Stop([
			"cannot combine --password-stdin with --open-cdb.",
			...usage(),
		]);
	}
	return opts;
}

function parseInitArgs(argv: string[], deps?: ParseDeps): InitOpts {
	const known = knownTemplateNames(deps);
	let template: string | undefined;
	const opts: InitOpts = { passwordStdin: false, openCdb: false };
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === undefined) continue;
		if (a === "--help" || a === "-h") throw new HelpRequest();
		if (a === "--version" || a === "-V") throw new VersionRequest();
		if (a === "--template") {
			const v = argv[++i];
			if (!v) throw new Stop(["--template needs a name.", ...usage()]);
			template = v;
		} else if (a === "--password-stdin") {
			opts.passwordStdin = true;
		} else if (a === "--open-cdb") {
			opts.openCdb = true;
		} else if (a.startsWith("-")) {
			throw new Stop([`Unknown init flag: ${a}`, ...usage()]);
		} else {
			positional.push(a);
		}
	}
	if (template !== undefined && !known.includes(template)) {
		throw new Stop([
			`Unknown template: ${template} (have: ${known.join(", ") || "none"}).`,
			...usage(),
		]);
	}
	if (opts.passwordStdin && opts.openCdb) {
		throw new Stop([
			"cannot combine --password-stdin with --open-cdb.",
			...usage(),
		]);
	}
	return { dir: onlyOneDir(positional, "init"), template, ...opts };
}

/** Thrown for --help so callers (and tests) see it without an exit. */
export class HelpRequest extends Error {
	constructor() {
		super("help requested");
		this.name = "HelpRequest";
	}
}

/** Thrown for --version so callers (and tests) see it without an exit. */
export class VersionRequest extends Error {
	constructor() {
		super("version requested");
		this.name = "VersionRequest";
	}
}

/**
 * Code parsing: ours are --yes/-y, --router, --print-only (anywhere);
 * the workspace dir, when given, is a positional ahead of every muse
 * arg; EVERYTHING else passes through to muse verbatim and in order,
 * and `--` forces the rest through (even --help). Once a muse arg
 * appears the dir slot closes, so `--model alpha` never makes `alpha`
 * the workspace.
 */
export function parseCodeArgs(argv: string[]): CodeOpts {
	const opts: CodeOpts = {
		yes: false,
		printOnly: false,
		passthrough: [],
	};
	let dirOpen = true;
	let rest = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === undefined) continue;
		if (rest) {
			opts.passthrough.push(a);
			continue;
		}
		if (a === "--") {
			rest = true;
			continue;
		}
		if (a === "--help" || a === "-h") throw new HelpRequest();
		if (a === "--version" || a === "-V") throw new VersionRequest();
		if (a === "--yes" || a === "-y") opts.yes = true;
		else if (a === "--print-only") opts.printOnly = true;
		else if (a === "--router") {
			const v = argv[++i];
			if (!v) throw new Stop(["--router needs a host.", ...usage()]);
			opts.router = v;
		} else if (dirOpen && !a.startsWith("-")) {
			opts.dir = a;
			dirOpen = false;
		} else {
			opts.passthrough.push(a);
			dirOpen = false;
		}
	}
	return opts;
}

function parseDoctorArgs(argv: string[]): DoctorOpts {
	const positional: string[] = [];
	for (const a of argv) {
		if (a === "--help" || a === "-h") throw new HelpRequest();
		if (a === "--version" || a === "-V") throw new VersionRequest();
		if (a.startsWith("-")) {
			throw new Stop([`Unknown doctor flag: ${a}`, ...usage()]);
		}
		positional.push(a);
	}
	return { dir: onlyOneDir(positional, "doctor") };
}

/**
 * Top-level parse. Bare argv is start; serve aliases start; start
 * --tui (bare or explicit) aliases code with code's own parsing.
 */
export function parseCli(argv: string[], deps?: ParseDeps): Parsed {
	const [first, ...rest] = argv;
	if (first === "start" || first === "serve") {
		if (rest.includes("--tui")) {
			return {
				cmd: "code",
				opts: parseCodeArgs(rest.filter((a) => a !== "--tui")),
			};
		}
		return { cmd: "start", opts: parseStartArgs(rest, deps) };
	}
	if (first === "init") {
		return { cmd: "init", opts: parseInitArgs(rest, deps) };
	}
	if (first === "code") {
		return { cmd: "code", opts: parseCodeArgs(rest) };
	}
	if (first === "doctor") {
		return { cmd: "doctor", opts: parseDoctorArgs(rest) };
	}
	// Bare = start (with the --tui alias honored here too).
	if (argv.includes("--tui")) {
		return {
			cmd: "code",
			opts: parseCodeArgs(argv.filter((a) => a !== "--tui")),
		};
	}
	return { cmd: "start", opts: parseStartArgs(argv, deps) };
}
