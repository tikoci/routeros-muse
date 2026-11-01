// CLI fleet reads (T40): `devices list` + `devices stats` over a
// workspace through the package-fronted bundle (D26) and the T64
// fail-closed CDB binding (workspace device.cdb, explicit --cdb-file
// override). Wires into src/lib/fleet, not a second implementation.
// Reads only — device writes are out of scope (T48 owns write UX).
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { deviceStats, listDevices } from "../lib/fleet";
import { askSecret } from "../lib/prompt";
import { Stop } from "../lib/stop";
import { toolBinDir, toolEnv } from "../lib/tools";
import { detectCdbMode, workerEnv } from "../serve/auth";

export function usageDevices(): string[] {
	return [
		"Usage: bunx routeros-muse devices list [workspace]",
		"       bunx routeros-muse devices stats <id> [workspace] [--cdb-file FILE]",
		"",
		"  list                 router.toml devices of the workspace (default: cwd)",
		"  stats <id>           live identity + resource for one device via centrs",
		"  --cdb-file FILE      stats only: bind this CDB instead of <workspace>/device.cdb",
		"  --help, -h           this help",
		"",
		"Reads only: device writes are out of scope here (T48 owns write UX).",
		"An encrypted CDB unlocks via CENTRS_CDB_PASSWORD or a TTY prompt",
		"(never echoed, never on the command line).",
	];
}

export type DevicesArgs =
	| { cmd: "list"; workspace?: string }
	| { cmd: "stats"; id: string; workspace?: string; cdbFile?: string };

export function parseDevices(argv: string[]): DevicesArgs {
	let cdbFile: string | undefined;
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === undefined) continue;
		if (a === "--cdb-file") {
			const v = argv[++i];
			if (!v) throw new Stop(["--cdb-file needs a path.", ...usageDevices()]);
			cdbFile = v;
		} else if (a === "--help" || a === "-h") {
			console.log(usageDevices().join("\n"));
			process.exit(0);
		} else if (a.startsWith("-")) {
			throw new Stop([`Unknown devices flag: ${a}`, ...usageDevices()]);
		} else {
			positional.push(a);
		}
	}
	const [cmd, ...rest] = positional;
	if (cmd === "list" && rest.length <= 1) {
		// list makes no centrs call, so an explicit CDB would be a lie
		// by silence — refuse it instead of ignoring it.
		if (cdbFile !== undefined) {
			throw new Stop([
				"devices list takes no --cdb-file (router.toml only; stats binds the CDB).",
				...usageDevices(),
			]);
		}
		return { cmd: "list", workspace: rest[0] };
	}
	if (cmd === "stats" && rest.length >= 1 && rest.length <= 2) {
		return { cmd: "stats", id: rest[0] as string, workspace: rest[1], cdbFile };
	}
	throw new Stop([`Usage: devices list|stats ...`, ...usageDevices()]);
}

/**
 * Workspace for CLI reads: the path arg, else the cwd. Serve-parity
 * bar (workspace.toml present), not the bootstrap's full validation —
 * no prompting, no cloning.
 */
export function resolveCliWorkspace(arg: string | undefined): string {
	const dir = arg ? path.resolve(process.cwd(), arg) : process.cwd();
	if (!nodeFs.existsSync(path.join(dir, "workspace.toml"))) {
		throw new Stop([
			`not a workspace (no workspace.toml): ${dir}`,
			"Pass a workspace path, or run from inside one.",
		]);
	}
	return dir;
}

/** Fail-closed binding (T64): the workspace device.cdb unless overridden. */
export function bindCdb(root: string, override: string | undefined): string {
	return override ?? path.join(root, "device.cdb");
}

export type DevicesOut = { exit: number; out: string; err: string };

/** Explicit run env (T51/T64): tests inject stubs, the CLI passes ambient. */
export type DevicesRunEnv = {
	toolBinDir?: string | null;
	baseEnv?: NodeJS.ProcessEnv;
	prompter?: (question: string) => Promise<string | null>;
};

function runBase(runEnv: DevicesRunEnv | undefined): {
	base: Record<string, string>;
	src: NodeJS.ProcessEnv;
} {
	const bin =
		runEnv?.toolBinDir === undefined ? toolBinDir() : runEnv.toolBinDir;
	const src = runEnv?.baseEnv ?? process.env;
	return { base: toolEnv(bin, src), src };
}

function deviceLine(s: {
	id: string;
	label?: string;
	site?: string;
	role?: string;
	host?: string;
	cdb?: string;
	user?: string;
}): string {
	const kv: string[] = [];
	if (s.label) kv.push(`label=${s.label}`);
	if (s.site) kv.push(`site=${s.site}`);
	if (s.role) kv.push(`role=${s.role}`);
	if (s.host) kv.push(`host=${s.host}`);
	if (s.cdb) kv.push(`cdb=${s.cdb}`);
	if (s.user) kv.push(`user=${s.user}`);
	return kv.length > 0 ? `${s.id} ${kv.join(" ")}` : s.id;
}

/** List the workspace devices (no centrs call, so no unlock involved). */
export async function devicesList(
	root: string,
	runEnv?: DevicesRunEnv,
): Promise<DevicesOut> {
	const { base } = runBase(runEnv);
	const listed = await listDevices(root, null, base);
	if (listed.devices.length === 0) {
		return {
			exit: 0,
			out: `no devices in ${path.join(root, "router.toml")}\n`,
			err: "",
		};
	}
	return {
		exit: 0,
		out: `${listed.devices.map(deviceLine).join("\n")}\n`,
		err: "",
	};
}

/**
 * Live stats for one device. An encrypted bound CDB unlocks via the
 * CENTRS_CDB_PASSWORD passthrough, else a no-echo TTY prompt, else an
 * honest stop — the password only ever rides the child env.
 */
export async function devicesStats(
	root: string,
	id: string,
	cdbFile: string,
	runEnv?: DevicesRunEnv,
): Promise<DevicesOut> {
	const { base, src } = runBase(runEnv);
	const listed = await listDevices(root, null, base);
	if (!listed.devices.some((s) => s.id === id)) {
		return { exit: 1, out: "", err: `error: no device ${id}\n` };
	}
	let password: string | null = null;
	const detected = await detectCdbMode(cdbFile, base);
	if (detected.mode === "encrypted") {
		const passthrough = src["CENTRS_CDB_PASSWORD"];
		if (passthrough) {
			password = passthrough;
		} else {
			const prompter = runEnv?.prompter ?? askSecret;
			const asked = await prompter(`CDB password for ${cdbFile}:`);
			if (!asked) {
				return {
					exit: 2,
					out: "",
					err: "error: CDB is encrypted and no password is available (set CENTRS_CDB_PASSWORD or run on a TTY).\n",
				};
			}
			password = asked;
		}
	}
	const res = await deviceStats(
		root,
		id,
		cdbFile,
		workerEnv(base, cdbFile, password),
	);
	const body = res.body as { ok?: unknown; why?: unknown };
	if (body?.ok === true) {
		return { exit: 0, out: `${JSON.stringify(res.body, null, 2)}\n`, err: "" };
	}
	const why = typeof body?.why === "string" ? body.why : "device stats failed";
	return { exit: 1, out: "", err: `error: ${why}\n` };
}
