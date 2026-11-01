#!/usr/bin/env bun
// routeros-muse — Stage 1 prototype (T30). Mode A bootstrap: check
// the machine, pin the trilogy, check the agent, open the workspace,
// probe capability, pick up handoffs, launch muse. Local-only.

import {
	bindCdb,
	devicesList,
	devicesStats,
	parseDevices,
	resolveCliWorkspace,
} from "./cli/devices";
import { type Args, createCtx, resumeLine } from "./ctx";
import { Stop } from "./lib/stop";
import {
	pinnedTools,
	toolBinDir,
	toolEnv,
	toolSource,
	toolSourceLines,
} from "./lib/tools";
import { isLoopbackHost, startServer } from "./serve/server";
import { checkAgent } from "./steps/agent";
import { loadDoctorSpec, printDoctor, runDoctor } from "./steps/doctor";
import { listHandoffs, printHandoffs } from "./steps/handoff";
import { launchAgent, launchLine } from "./steps/launch";
import {
	comparePins,
	detectInstalled,
	mismatchMessage,
	printInstalled,
	resolvePins,
	TRILOGY,
	unpinnedMessage,
} from "./steps/pins";
import { checkPrereqs, printPrereqs } from "./steps/prereqs";
import { mapMode, probeLan, probeTwins } from "./steps/probe";
import { openWorkspace } from "./steps/workspace";

const VERSION = "0.1.0-dev.0";

function usage(): string[] {
	return [
		"Usage: bunx routeros-muse [workspace] [options]",
		"       bunx routeros-muse serve [workspace] [--port N] [--host H] [--provider NAME]",
		"       bunx routeros-muse serve --no-workspace [--port N] [--host H] [--provider NAME]",
		"       bunx routeros-muse devices list [workspace]",
		"       bunx routeros-muse devices stats <id> [workspace] [--cdb-file FILE]",
		"",
		"  workspace            local folder or git URL of the network workspace",
		"  serve                Mode B: loopback web UI over the workspace (T31)",
		"  devices              CLI fleet reads over a workspace (T40; writes: T48)",
		"  --no-workspace       serve with no workspace: centrs/quickchr only (T38, D23)",
		"  --port N             serve port (default: ephemeral)",
		"  --host H             bind host (default 127.0.0.1; 0.0.0.0 exposes the LAN)",
		"  --provider NAME      muse provider for chat (default: meta; echo for tests)",
		"  --allow-open-cdb       dev hatch: an open CDB implies no auth (T39, D24)",
		"  --router H[:port]    LAN probe target (default ports 8728, 8291, 22)",
		"  --yes, -y            one-yes: allow echoed user-level installs, no prompt",
		"  --yolo               forward to the muse launch only (agent approval mode)",
		"  --print-only         print the launch line instead of running it",
		"  --version, -V        print version",
		"  --help, -h           this help",
		"",
		"The contract: install Bun following Bun's own instructions, install",
		"`muse` and sign in, then run `bunx routeros-muse`. It checks your",
		"machine, opens your network workspace, and tells you the exact",
		"next step. Nothing installs without asking you.",
	];
}

function parseArgs(argv: string[]): Args {
	const args: Args = { yes: false, yolo: false, printOnly: false };
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === undefined) continue;
		if (a === "--yes" || a === "-y") args.yes = true;
		else if (a === "--yolo") args.yolo = true;
		else if (a === "--print-only") args.printOnly = true;
		else if (a === "--router") {
			const v = argv[++i];
			if (!v) throw new Stop(["--router needs a host.", ...usage()]);
			args.router = v;
		} else if (a === "--version" || a === "-V") {
			console.log(`routeros-muse ${VERSION}`);
			process.exit(0);
		} else if (a === "--help" || a === "-h") {
			console.log(usage().join("\n"));
			process.exit(0);
		} else if (a.startsWith("-")) {
			throw new Stop([`Unknown flag: ${a}`, ...usage()]);
		} else {
			positional.push(a);
		}
	}
	if (positional.length > 1) {
		throw new Stop(["Only one workspace argument.", ...usage()]);
	}
	args.workspace = positional[0];
	return args;
}

function parseServe(argv: string[]): {
	workspace?: string;
	noWorkspace?: boolean;
	port?: number;
	host?: string;
	provider?: string;
	allowOpenCdb?: boolean;
} {
	const out: {
		workspace?: string;
		noWorkspace?: boolean;
		port?: number;
		host?: string;
		provider?: string;
		allowOpenCdb?: boolean;
	} = {};
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === undefined) continue;
		if (a === "--port") {
			const v = Number(argv[++i]);
			if (!Number.isInteger(v) || v < 0 || v > 65535) {
				throw new Stop(["--port needs a number 0-65535.", ...usage()]);
			}
			out.port = v;
		} else if (a === "--host") {
			const v = argv[++i];
			if (!v) throw new Stop(["--host needs an address.", ...usage()]);
			out.host = v;
		} else if (a === "--provider") {
			const v = argv[++i];
			if (!v) throw new Stop(["--provider needs a name.", ...usage()]);
			out.provider = v;
		} else if (a === "--no-workspace") {
			out.noWorkspace = true;
		} else if (a === "--allow-open-cdb") {
			out.allowOpenCdb = true;
		} else if (a === "--help" || a === "-h") {
			console.log(usage().join("\n"));
			process.exit(0);
		} else if (a.startsWith("-")) {
			throw new Stop([`Unknown serve flag: ${a}`, ...usage()]);
		} else {
			positional.push(a);
		}
	}
	if (positional.length > 1) {
		throw new Stop(["Only one workspace argument.", ...usage()]);
	}
	out.workspace = positional[0];
	if (out.noWorkspace && out.workspace !== undefined) {
		throw new Stop(["--no-workspace takes no workspace argument.", ...usage()]);
	}
	return out;
}

async function main(): Promise<void> {
	const raw = process.argv.slice(2);
	if (raw[0] === "devices") {
		const dargs = parseDevices(raw.slice(1));
		const root = resolveCliWorkspace(dargs.workspace);
		const res =
			dargs.cmd === "list"
				? await devicesList(root)
				: await devicesStats(root, dargs.id, bindCdb(root, dargs.cdbFile));
		if (res.out) process.stdout.write(res.out);
		if (res.err) process.stderr.write(res.err);
		process.exit(res.exit);
	}
	if (raw[0] === "serve") {
		const sopts = parseServe(raw.slice(1));
		let dir: string | null = null;
		if (!sopts.noWorkspace) {
			const ctx = createCtx({
				yes: false,
				yolo: false,
				printOnly: false,
				workspace: sopts.workspace,
			});
			dir = (await openWorkspace(sopts.workspace, ctx)).dir;
		}
		const srv = await startServer({
			workspace: dir ?? undefined,
			noWorkspace: sopts.noWorkspace,
			port: sopts.port,
			host: sopts.host,
			provider: sopts.provider,
			allowOpenCdb: sopts.allowOpenCdb,
		});
		const where = dir ?? "no workspace (centrs/quickchr only)";
		if (isLoopbackHost(srv.hostname)) {
			console.log(
				`routeros-muse Mode B on ${srv.url} (loopback only, ${where})`,
			);
			console.log("Open that URL in a browser. Ctrl-C stops the server.");
			console.log(
				"Remote access: re-run with --host 0.0.0.0 to expose the LAN.",
			);
		} else {
			console.log(`routeros-muse Mode B on ${srv.url} (${where})`);
			console.log(
				"WARNING: bound to the network, not loopback — anyone who can reach",
			);
			console.log(
				"this machine can drive the agent. Prefer loopback + ssh -L when unsure.",
			);
			if (srv.urls.length > 0) {
				console.log("Reachable at:");
				for (const u of srv.urls) console.log(`  ${u}`);
			}
			console.log("Ctrl-C stops the server.");
		}
		process.on("SIGINT", () => {
			void srv.stop().then(() => process.exit(0));
		});
		await new Promise(() => {});
		return;
	}
	const ctx = createCtx(parseArgs(raw));

	console.log("== 1. prereqs ==");
	const prereqs = await checkPrereqs();
	printPrereqs(prereqs);

	console.log("== 2. trilogy ==");
	// T51/D26: package.json owns the trilogy versions. Front the
	// package bundle on PATH once; every trilogy spawn below (and the
	// agent launch at the end) inherits this env, never ambient globals.
	const binDir = toolBinDir();
	const tools = toolEnv(binDir);
	const source = toolSource(binDir);
	for (const line of toolSourceLines(pinnedTools(), binDir)) {
		console.log(line);
	}
	const installed = await detectInstalled(tools);
	printInstalled(installed);

	console.log("== 3. agent ==");
	await checkAgent(ctx);

	console.log("== 4. workspace ==");
	const { dir, config } = await openWorkspace(ctx.args.workspace, ctx);

	console.log("== 4b. pins ==");
	const resolved = await resolvePins(config.pins);
	if (resolved.failed.length > 0) {
		throw new Stop([
			`Could not resolve @next for ${resolved.failed.join(", ")} (registry unreachable?).`,
			"Check the network, then resume:",
			`  ${resumeLine(ctx)}`,
		]);
	}
	const { unpinned, mismatched } = comparePins(resolved.pins, installed);
	if (unpinned.length > 0) {
		throw new Stop([
			...unpinnedMessage(unpinned, installed),
			`  ${resumeLine(ctx)}`,
		]);
	}
	if (mismatched.length > 0) {
		throw new Stop([
			...mismatchMessage(mismatched, source),
			`  ${resumeLine(ctx)}`,
		]);
	}
	console.log(`  pins match (${TRILOGY.join(", ")})`);

	console.log("== 5. probe ==");
	const twins = await probeTwins(tools);
	console.log(
		`  twins: ${twins.capable ? twins.detail : `NO — ${twins.detail}`}` +
			(twins.defined !== null
				? `; ${twins.defined} defined, ${twins.running ?? "?"} running`
				: ""),
	);
	const lan = await probeLan(ctx.args.router, tools);
	console.log(
		`  lan: ${lan.reachable ? `reachable (${lan.via.join("; ")})` : "no router seen (MNDP quiet; no --router target reached)"}`,
	);
	const entries = await loadDoctorSpec(dir);
	const doctorResults = await runDoctor(entries, prereqs.os);
	const missingRequired = printDoctor(doctorResults);
	if (missingRequired.length > 0) {
		throw new Stop([
			`Required tools missing: ${missingRequired.map((e) => e.id).join(", ")}.`,
			"Install them (hints above; system-level is print-only), then resume:",
			`  ${resumeLine(ctx)}`,
		]);
	}
	const mode = mapMode(twins.capable, lan.reachable);
	console.log(`  capability mode: ${mode}`);

	console.log("== 6. handoffs ==");
	printHandoffs(listHandoffs(dir));

	const line = launchLine(ctx.args.yolo);
	console.log(`Next: run \`${line}\` in ${dir}`);
	if (ctx.args.printOnly) {
		console.log("--print-only: stopping before launch.");
		return;
	}
	console.log(`Launching \`${line}\` ...`);
	await launchAgent(dir, ctx.args.yolo, tools);
}

try {
	await main();
} catch (err) {
	if (err instanceof Stop) {
		for (const line of err.lines) console.log(line);
		process.exit(2);
	}
	console.error(
		`unexpected error: ${err instanceof Error ? err.message : String(err)}`,
	);
	process.exit(1);
}
