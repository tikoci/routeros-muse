#!/usr/bin/env bun
// routeros-muse — owner CLI (T93, D35). Bare is start: serve the
// workspace UI and open the browser. init scaffolds, code checks
// then execs muse, doctor checks print-only. Local-only.
import * as path from "node:path";
import { HelpRequest, parseCli, usage, VersionRequest } from "./cli/args";
import { runCode, runDoctor } from "./cli/checks";
import { runInit } from "./cli/init";
import { openBrowser } from "./cli/open";
import { resolveStart } from "./cli/resolve";
import { readPackageVersion } from "./cli/version";
import { ask, askSecret, isTty, readStdinPassword } from "./lib/prompt";
import { registryFile } from "./lib/registry";
import { Stop } from "./lib/stop";
import { toolBinDir, toolEnv } from "./lib/tools";
import { isLoopbackHost, startServer } from "./serve/server";
import { launchAgent } from "./steps/launch";

async function main(): Promise<void> {
	const raw = process.argv.slice(2);
	let parsed: ReturnType<typeof parseCli>;
	try {
		parsed = parseCli(raw);
	} catch (err) {
		if (err instanceof HelpRequest) {
			console.log(usage().join("\n"));
			return;
		}
		if (err instanceof VersionRequest) {
			console.log(`routeros-muse ${readPackageVersion()}`);
			return;
		}
		throw err;
	}

	if (parsed.cmd === "init") {
		const dir = parsed.opts.dir
			? path.resolve(process.cwd(), parsed.opts.dir)
			: process.cwd();
		const res = await runInit(
			dir,
			{
				template: parsed.opts.template,
				passwordStdin: parsed.opts.passwordStdin,
				openCdb: parsed.opts.openCdb,
			},
			{
				print: (line) => console.log(line),
				isTty: isTty(),
				ask,
				askSecret,
				readStdinPassword,
				registryFile: registryFile(),
				env: toolEnv(toolBinDir()),
			},
		);
		process.exit(res.ok ? 0 : 1);
	}

	if (parsed.cmd === "code") {
		await runCode(parsed.opts, {
			exec: (dir, args, env) => launchAgent(dir, args, env),
		});
		return;
	}

	if (parsed.cmd === "doctor") {
		const report = await runDoctor(parsed.opts.dir, {});
		process.exit(report.ok ? 0 : 1);
	}

	// start (bare or explicit; serve aliases here)
	const s = parsed.opts;
	const tools = toolEnv(toolBinDir());
	let dir: string | null = null;
	let noWs = s.noWorkspace === true;
	if (!noWs) {
		const resolved = await resolveStart(
			s.dir ? path.resolve(process.cwd(), s.dir) : process.cwd(),
			{
				isTty: isTty(),
				ask,
				askSecret,
				readStdinPassword,
				print: (line) => console.log(line),
				registryFile: registryFile(),
				env: tools,
				explicit: s.dir !== undefined,
				template: s.template,
				passwordStdin: s.passwordStdin,
				openCdb: s.openCdb,
			},
		);
		if (resolved.kind === "abort") process.exit(2);
		if (resolved.kind === "serve") dir = resolved.dir;
		else noWs = true;
	}
	const srv = await startServer({
		workspace: dir ?? undefined,
		noWorkspace: noWs,
		port: s.port,
		host: s.host,
		provider: s.provider,
		allowOpenCdb: s.allowOpenCdb,
		defaultApprovalMode: s.yolo ? "allowAll" : undefined,
		trustWorkspace: s.noTrustWorkspace ? false : undefined,
	});
	const where = dir ?? "no workspace (centrs/quickchr only)";
	if (isLoopbackHost(srv.hostname)) {
		console.log(`routeros-muse on ${srv.url} (loopback only, ${where})`);
		if (!s.noOpen) {
			if (openBrowser(srv.url)) {
				console.log("Opened in your browser (--no-open to skip).");
			} else {
				console.log("No display found; open the URL above in a browser.");
			}
		} else {
			console.log("Open that URL in a browser. Ctrl-C stops the server.");
		}
		console.log("Remote access: re-run with --host 0.0.0.0 to expose the LAN.");
	} else {
		console.log(`routeros-muse on ${srv.url} (${where})`);
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
	// T133 review P2: both signals end the session — stop() takes
	// spawned workspace children down with the picker.
	const shutdown = () => {
		void srv.stop().then(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	await new Promise(() => {});
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
