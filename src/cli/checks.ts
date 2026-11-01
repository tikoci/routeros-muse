// Code + doctor runners (T93): the Mode A bootstrap steps, shared.
// code runs them enforcing (Stop with a resume line), then execs
// muse with the package bundle env (D26 PATH fronting); doctor runs
// the same steps print-only, never installs, never execs, and exits
// 1 when a required item is missing.
import * as path from "node:path";
import { createCtx, resumeLine } from "../ctx";
import { Stop } from "../lib/stop";
import {
	pinnedTools,
	toolBinDir,
	toolEnv,
	toolSource,
	toolSourceLines,
} from "../lib/tools";
import { checkAgent, reportAgent } from "../steps/agent";
import {
	loadDoctorSpec,
	printDoctor,
	runDoctor as runDoctorSpec,
} from "../steps/doctor";
import { listHandoffs, printHandoffs } from "../steps/handoff";
import { launchLine } from "../steps/launch";
import {
	comparePins,
	detectInstalled,
	mismatchMessage,
	printInstalled,
	resolvePins,
	TRILOGY,
	unpinnedMessage,
} from "../steps/pins";
import { checkPrereqs, printPrereqs } from "../steps/prereqs";
import {
	type LanReport,
	mapMode,
	probeLan,
	probeTwins,
	type TwinReport,
} from "../steps/probe";
import { openWorkspace, readAndValidate } from "../steps/workspace";
import type { CodeOpts } from "./args";

export type CheckDeps = {
	/** Exec for the code launch (tests inject a spy; never used by doctor). */
	exec: (
		dir: string,
		args: string[],
		env: Record<string, string>,
	) => Promise<never>;
	/** Probe overrides (tests skip the slow/network legs). */
	twins?: () => Promise<TwinReport>;
	lan?: (router?: string) => Promise<LanReport>;
};

export type DoctorDeps = {
	twins?: () => Promise<TwinReport>;
	lan?: (router?: string) => Promise<LanReport>;
};

export type DoctorReport = { ok: boolean; failures: string[] };

/**
 * Code: enforcing bootstrap, then muse. --yes keeps its one-yes
 * meaning; passthrough reaches the launch verbatim.
 */
export async function runCode(opts: CodeOpts, deps: CheckDeps): Promise<void> {
	const ctx = createCtx({
		workspace: opts.dir ?? process.cwd(),
		yes: opts.yes,
		printOnly: opts.printOnly,
		router: opts.router,
	});

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
	const twins = deps.twins ? await deps.twins() : await probeTwins(tools);
	console.log(
		`  twins: ${twins.capable ? twins.detail : `NO — ${twins.detail}`}` +
			(twins.defined !== null
				? `; ${twins.defined} defined, ${twins.running ?? "?"} running`
				: ""),
	);
	const lan = deps.lan
		? await deps.lan(ctx.args.router)
		: await probeLan(ctx.args.router, tools);
	console.log(
		`  lan: ${lan.reachable ? `reachable (${lan.via.join("; ")})` : "no router seen (MNDP quiet; no --router target reached)"}`,
	);
	const entries = await loadDoctorSpec(dir);
	const doctorResults = await runDoctorSpec(entries, prereqs.os);
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

	const line = launchLine(opts.passthrough);
	console.log(`Next: run \`${line}\` in ${dir}`);
	if (ctx.args.printOnly) {
		console.log("--print-only: stopping before launch.");
		return;
	}
	console.log(`Launching \`${line}\` ...`);
	await deps.exec(dir, opts.passthrough, tools);
}

/**
 * Doctor: the same steps, print-only. Never installs, never prompts,
 * never execs muse. Twin/LAN absence degrades the mode, never fails
 * (probe semantics, as in code).
 */
export async function runDoctor(
	dirArg: string | undefined,
	deps: DoctorDeps,
): Promise<DoctorReport> {
	const failures: string[] = [];
	const dir = dirArg ? path.resolve(dirArg) : process.cwd();
	const label = dirArg ?? dir;

	console.log("== 1. prereqs ==");
	const prereqs = await checkPrereqs();
	printPrereqs(prereqs);

	console.log("== 2. trilogy ==");
	const binDir = toolBinDir();
	const tools = toolEnv(binDir);
	const source = toolSource(binDir);
	for (const line of toolSourceLines(pinnedTools(), binDir)) {
		console.log(line);
	}
	const installed = await detectInstalled(tools);
	printInstalled(installed);

	console.log("== 3. agent ==");
	const agent = await reportAgent(label);
	failures.push(...agent.missing);

	console.log("== 4. workspace ==");
	const validated = await readAndValidate(dir);
	if (!validated.ok) {
		for (const line of validated.reason) console.log(`  ${line}`);
		failures.push("workspace (invalid)");
	} else {
		const type = validated.config.home["type"];
		console.log(
			`  workspace valid (home type: ${typeof type === "string" ? type : "unknown"}, canonical)`,
		);
	}

	console.log("== 4b. pins ==");
	if (!validated.ok) {
		console.log("  skipped (no workspace)");
	} else {
		const resolved = await resolvePins(validated.config.pins);
		if (resolved.failed.length > 0) {
			console.log(
				`  could not resolve @next for ${resolved.failed.join(", ")} (registry unreachable?)`,
			);
			failures.push(
				...resolved.failed.map((t) => `pins:${t} (@next unresolvable)`),
			);
		} else {
			const { unpinned, mismatched } = comparePins(resolved.pins, installed);
			if (unpinned.length > 0) {
				for (const line of unpinnedMessage(unpinned, installed)) {
					console.log(`  ${line}`);
				}
				failures.push(...unpinned.map((t) => `pins:${t} (unpinned)`));
			}
			if (mismatched.length > 0) {
				for (const line of mismatchMessage(mismatched, source)) {
					console.log(`  ${line}`);
				}
				failures.push(
					...mismatched.map(
						(m) =>
							`pins:${m.tool} (running ${m.installed ?? "missing"} vs verified ${m.pin})`,
					),
				);
			}
			if (unpinned.length === 0 && mismatched.length === 0) {
				console.log(`  pins match (${TRILOGY.join(", ")})`);
			}
		}
	}

	console.log("== 5. probe ==");
	const twins = deps.twins ? await deps.twins() : await probeTwins(tools);
	console.log(
		`  twins: ${twins.capable ? twins.detail : `NO — ${twins.detail}`}` +
			(twins.defined !== null
				? `; ${twins.defined} defined, ${twins.running ?? "?"} running`
				: ""),
	);
	const lan = deps.lan ? await deps.lan() : await probeLan(undefined, tools);
	console.log(
		`  lan: ${lan.reachable ? `reachable (${lan.via.join("; ")})` : "no router seen (MNDP quiet)"}`,
	);
	const entries = await loadDoctorSpec(dir);
	const doctorResults = await runDoctorSpec(entries, prereqs.os);
	const missingRequired = printDoctor(doctorResults);
	failures.push(...missingRequired.map((e) => `doctor:${e.id} (missing)`));
	const mode = mapMode(twins.capable, lan.reachable);
	console.log(`  capability mode: ${mode}`);

	console.log("== 6. handoffs ==");
	printHandoffs(listHandoffs(dir));

	if (failures.length > 0) {
		console.log(
			`doctor: ${failures.length} required item${failures.length === 1 ? "" : "s"} missing`,
		);
	} else {
		console.log("doctor: all required items present");
	}
	return { ok: failures.length === 0, failures };
}
