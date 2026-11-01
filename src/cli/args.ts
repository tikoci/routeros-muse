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
		"  init: --template minimal|network (default: minimal)",
		"  code: --yes, --router H[:port], --print-only; the rest passes to muse (-- ends our flags)",
		"",
		"Developer flags (start): --no-workspace, --provider NAME, --allow-open-cdb",
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
};

export type InitOpts = { dir?: string; template: string };

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

function parseStartArgs(argv: string[]): StartOpts {
	const opts: StartOpts = { noOpen: false, yolo: false };
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
		} else if (a === "--no-open") {
			opts.noOpen = true;
		} else if (a === "--yolo") {
			opts.yolo = true;
		} else if (a === "--no-workspace") {
			opts.noWorkspace = true;
		} else if (a === "--allow-open-cdb") {
			opts.allowOpenCdb = true;
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
	return opts;
}

function parseInitArgs(argv: string[], deps?: ParseDeps): InitOpts {
	const known = knownTemplateNames(deps);
	let template = "minimal";
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
		} else if (a.startsWith("-")) {
			throw new Stop([`Unknown init flag: ${a}`, ...usage()]);
		} else {
			positional.push(a);
		}
	}
	if (!known.includes(template)) {
		throw new Stop([
			`Unknown template: ${template} (have: ${known.join(", ") || "none"}).`,
			...usage(),
		]);
	}
	return { dir: onlyOneDir(positional, "init"), template };
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
 * Code parsing: ours are --yes/-y, --router, --print-only; the first
 * positional is the workspace dir; EVERYTHING else passes through to
 * muse verbatim, and `--` forces the rest through (even --help).
 */
export function parseCodeArgs(argv: string[]): CodeOpts {
	const opts: CodeOpts = {
		yes: false,
		printOnly: false,
		passthrough: [],
	};
	const positional: string[] = [];
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
		} else if (a.startsWith("-")) {
			opts.passthrough.push(a);
		} else {
			positional.push(a);
		}
	}
	if (positional.length > 0) {
		opts.dir = positional[0];
		// Later positionals belong to muse, not to us.
		opts.passthrough.push(...positional.slice(1));
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
		return { cmd: "start", opts: parseStartArgs(rest) };
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
	return { cmd: "start", opts: parseStartArgs(argv) };
}
