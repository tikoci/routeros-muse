// Owner CLI tests (T93, D35): arg parsing per command (passthrough
// and `--` rules), workspace resolution with injected TTY/prompt,
// init no-clobber, browser-open selection, doctor-never-execs.
// Hermetic: temp dirs (all cleaned in afterAll), stub muse/centrs,
// injected probes; no live meta turns, no real routers.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	HelpRequest,
	parseCli,
	parseCodeArgs,
	usage,
	VersionRequest,
} from "../src/cli/args";
import { runCode, runDoctor } from "../src/cli/checks";
import { runInit } from "../src/cli/init";
import { browserOpenCommand, openBrowser } from "../src/cli/open";
import { type ResolveDeps, resolveStart } from "../src/cli/resolve";
import { readPackageVersion } from "../src/cli/version";
import {
	readRegistry,
	registerWorkspace,
	registryFile,
} from "../src/lib/registry";
import { Stop } from "../src/lib/stop";
import { detectInstalled, toolBinDir, toolEnv } from "../src/lib/tools";
import { museAuthFile } from "../src/steps/agent";

const POSIX = process.platform !== "win32";
const tposix = POSIX ? test : test.skip;

const tmpdirs: string[] = [];
afterAll(() => {
	for (const d of tmpdirs) {
		nodeFs.rmSync(d, { recursive: true, force: true });
	}
});

function mktmp(prefix: string): string {
	const d = nodeFs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpdirs.push(d);
	return d;
}

function writeShim(dir: string, name: string, body: string): void {
	const file = path.join(dir, name);
	nodeFs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
	nodeFs.chmodSync(file, 0o755);
}

/** Stub bin dir: centrs answers `devices init --cdb-file F` by touching F. */
function stubCentrsBin(): string {
	const dir = mktmp("t93-stubbin-");
	writeShim(
		dir,
		"centrs",
		`while [ $# -gt 0 ]; do if [ "$1" = "--cdb-file" ]; then : > "$2"; exit 0; fi; shift; done\nexit 1`,
	);
	return dir;
}

function writeWorkspace(
	dir: string,
	pins?: Record<string, string>,
	extraToml = "",
): void {
	nodeFs.writeFileSync(
		path.join(dir, "workspace.toml"),
		`[home]\ntype = "single-copy"\ncanonical = true\n\n[pins]\n${Object.entries(
			pins ?? {
				quickchr: "0.0.0-t93",
				centrs: "0.0.0-t93",
				rosetta: "0.0.0-t93",
			},
		)
			.map(([k, v]) => `${k} = "${v}"`)
			.join("\n")}\n${extraToml}`,
	);
	nodeFs.writeFileSync(path.join(dir, "AGENTS.md"), "# t93 ws\n");
}

describe("parseCli", () => {
	test("bare is start with defaults", () => {
		expect(parseCli([])).toEqual({
			cmd: "start",
			opts: { noOpen: false, yolo: false, dir: undefined },
		});
	});

	test("bare flags parse as start", () => {
		const p = parseCli(["--port", "3000", "--no-open"]);
		expect(p.cmd).toBe("start");
		if (p.cmd === "start") {
			expect(p.opts.port).toBe(3000);
			expect(p.opts.noOpen).toBe(true);
		}
	});

	test("start and serve alias", () => {
		const a = parseCli(["start", "./ws", "--host", "0.0.0.0", "--yolo"]);
		expect(a.cmd).toBe("start");
		if (a.cmd === "start") {
			expect(a.opts.dir).toBe("./ws");
			expect(a.opts.host).toBe("0.0.0.0");
			expect(a.opts.yolo).toBe(true);
		}
		expect(parseCli(["serve", "./ws"])).toEqual({
			cmd: "start",
			opts: { noOpen: false, yolo: false, dir: "./ws" },
		});
	});

	test("start developer flags", () => {
		const p = parseCli([
			"start",
			"--no-workspace",
			"--provider",
			"echo",
			"--allow-open-cdb",
		]);
		expect(p.cmd).toBe("start");
		if (p.cmd === "start") {
			expect(p.opts.noWorkspace).toBe(true);
			expect(p.opts.provider).toBe("echo");
			expect(p.opts.allowOpenCdb).toBe(true);
		}
	});

	test("start rejects bad shapes", () => {
		expect(() => parseCli(["start", "a", "b"])).toThrow(Stop);
		expect(() => parseCli(["start", "--port", "nope"])).toThrow(Stop);
		expect(() => parseCli(["start", "--port", "70000"])).toThrow(Stop);
		expect(() => parseCli(["start", "--host"])).toThrow(Stop);
		expect(() => parseCli(["start", "--no-workspace", "./ws"])).toThrow(Stop);
		expect(() => parseCli(["start", "--bogus"])).toThrow(Stop);
	});

	test("start --tui aliases code (explicit and bare)", () => {
		const p = parseCli(["start", "--tui", "./ws", "-c"]);
		expect(p.cmd).toBe("code");
		if (p.cmd === "code") {
			expect(p.opts.dir).toBe("./ws");
			expect(p.opts.passthrough).toEqual(["-c"]);
		}
		const b = parseCli(["--tui", "--yes"]);
		expect(b.cmd).toBe("code");
		if (b.cmd === "code") expect(b.opts.yes).toBe(true);
		expect(parseCli(["serve", "--tui"])).toMatchObject({ cmd: "code" });
	});

	test("init defaults and template", () => {
		expect(parseCli(["init"])).toEqual({
			cmd: "init",
			opts: { dir: undefined, template: "minimal" },
		});
		expect(parseCli(["init", "./ws", "--template", "network"])).toEqual({
			cmd: "init",
			opts: { dir: "./ws", template: "network" },
		});
	});

	test("init rejects unknown template, extra dirs, unknown flags", () => {
		expect(() =>
			parseCli(["init", "--template", "nope"], {
				knownTemplates: ["minimal", "network"],
			}),
		).toThrow(Stop);
		expect(() => parseCli(["init", "a", "b"])).toThrow(Stop);
		expect(() => parseCli(["init", "--yes"])).toThrow(Stop);
	});

	test("code defaults", () => {
		expect(parseCli(["code"])).toEqual({
			cmd: "code",
			opts: {
				dir: undefined,
				yes: false,
				printOnly: false,
				passthrough: [],
			},
		});
	});

	test("code ours vs passthrough", () => {
		const p = parseCodeArgs([
			"./ws",
			"--yes",
			"--router",
			"gw",
			"--print-only",
			"-c",
			"--yolo",
			"--resume",
		]);
		expect(p.dir).toBe("./ws");
		expect(p.yes).toBe(true);
		expect(p.router).toBe("gw");
		expect(p.printOnly).toBe(true);
		expect(p.passthrough).toEqual(["-c", "--yolo", "--resume"]);
	});

	test("code later positionals pass through; first is the dir", () => {
		const p = parseCodeArgs(["resume"]);
		expect(p.dir).toBe("resume");
		expect(p.passthrough).toEqual([]);
		const q = parseCodeArgs(["./ws", "resume"]);
		expect(q.dir).toBe("./ws");
		expect(q.passthrough).toEqual(["resume"]);
	});

	test("code -- forces the rest through", () => {
		const p = parseCodeArgs(["--", "--yes", "resume", "--help"]);
		expect(p.dir).toBeUndefined();
		expect(p.yes).toBe(false);
		expect(p.passthrough).toEqual(["--yes", "resume", "--help"]);
		const q = parseCodeArgs(["./ws", "--yes", "--", "--yes"]);
		expect(q.yes).toBe(true);
		expect(q.passthrough).toEqual(["--yes"]);
	});

	test("code keeps muse args in order; dir only leads", () => {
		// sol review of T93: positionals were appended after flags,
		// and a flag's value could be taken as the workspace dir.
		const a = parseCodeArgs(["./ws", "--model", "alpha", "--effort", "high"]);
		expect(a.dir).toBe("./ws");
		expect(a.passthrough).toEqual(["--model", "alpha", "--effort", "high"]);
		const b = parseCodeArgs(["--model", "alpha"]);
		expect(b.dir).toBeUndefined();
		expect(b.passthrough).toEqual(["--model", "alpha"]);
		const c = parseCodeArgs(["./ws", "resume", "--", "abc"]);
		expect(c.dir).toBe("./ws");
		expect(c.passthrough).toEqual(["resume", "abc"]);
		// Our flags may sit anywhere and still are ours.
		const d = parseCodeArgs(["--yes", "./ws", "-c", "--print-only", "x"]);
		expect(d.dir).toBe("./ws");
		expect(d.yes).toBe(true);
		expect(d.printOnly).toBe(true);
		expect(d.passthrough).toEqual(["-c", "x"]);
	});

	test("code --router needs a value", () => {
		expect(() => parseCodeArgs(["--router"])).toThrow(Stop);
	});

	test("doctor takes only a dir", () => {
		expect(parseCli(["doctor"])).toEqual({
			cmd: "doctor",
			opts: { dir: undefined },
		});
		expect(parseCli(["doctor", "./ws"])).toEqual({
			cmd: "doctor",
			opts: { dir: "./ws" },
		});
		expect(() => parseCli(["doctor", "a", "b"])).toThrow(Stop);
		expect(() => parseCli(["doctor", "--yes"])).toThrow(Stop);
	});

	test("--help and --version short-circuit every command", () => {
		for (const argv of [
			["--help"],
			["-h"],
			["start", "--help"],
			["init", "--help"],
			["doctor", "--help"],
			["code", "--help"],
		]) {
			expect(() => parseCli(argv)).toThrow(HelpRequest);
		}
		for (const argv of [
			["--version"],
			["-V"],
			["start", "--version"],
			["code", "--version"],
		]) {
			expect(() => parseCli(argv)).toThrow(VersionRequest);
		}
		// ... except past code's `--`: the rest is muse's.
		const p = parseCodeArgs(["--", "--help", "--version"]);
		expect(p.passthrough).toEqual(["--help", "--version"]);
	});

	test("usage names commands, common flags, developer flags", () => {
		const text = usage().join("\n");
		for (const word of [
			"start",
			"init",
			"code",
			"doctor",
			"--no-open",
			"--template",
			"--print-only",
			"Developer flags",
			"--no-workspace",
			"--provider",
			"--allow-open-cdb",
		]) {
			expect(text).toContain(word);
		}
		expect(text).not.toContain("devices");
	});
});

describe("browser open", () => {
	test("darwin uses open", () => {
		expect(browserOpenCommand("http://x/", { platform: "darwin" })).toEqual([
			"open",
			"http://x/",
		]);
	});

	test("win32 uses cmd start", () => {
		expect(browserOpenCommand("http://x/", { platform: "win32" })).toEqual([
			"cmd",
			"/c",
			"start",
			"http://x/",
		]);
	});

	test("linux needs a display", () => {
		expect(
			browserOpenCommand("http://x/", {
				platform: "linux",
				env: { DISPLAY: ":0" },
			}),
		).toEqual(["xdg-open", "http://x/"]);
		expect(
			browserOpenCommand("http://x/", {
				platform: "linux",
				env: { WAYLAND_DISPLAY: "wayland-0" },
			}),
		).toEqual(["xdg-open", "http://x/"]);
		expect(
			browserOpenCommand("http://x/", { platform: "linux", env: {} }),
		).toBeNull();
	});

	test("openBrowser spawns injected, false without a command", () => {
		const seen: string[][] = [];
		expect(
			openBrowser("http://x/", {
				platform: "darwin",
				spawn: (c) => seen.push(c),
			}),
		).toBe(true);
		expect(seen).toEqual([["open", "http://x/"]]);
		expect(
			openBrowser("http://x/", {
				platform: "linux",
				env: {},
				spawn: (c) => seen.push(c),
			}),
		).toBe(false);
		expect(seen.length).toBe(1);
	});
});

describe("version", () => {
	test("reads package.json, unknown without a root", () => {
		expect(readPackageVersion()).toMatch(/\d+\.\d+\.\d+/);
		expect(readPackageVersion(null)).toBe("unknown");
	});
});

function resolveDeps(over: Partial<ResolveDeps> & { answers?: string[] }): {
	deps: ResolveDeps;
	printed: string[];
} {
	const printed: string[] = [];
	const answers = [...(over.answers ?? [])];
	const dh = mktmp("t93-resolve-dh-");
	return {
		deps: {
			isTty: over.isTty ?? false,
			ask: async () => answers.shift() ?? null,
			print: (line) => printed.push(line),
			registryFile: over.registryFile ?? registryFile(dh),
			env: over.env ?? toolEnv(stubCentrsBin()),
			...(over.templatesRoot !== undefined
				? { templatesRoot: over.templatesRoot }
				: {}),
		},
		printed,
	};
}

describe("resolveStart", () => {
	tposix("valid workspace serves without asking", async () => {
		const dir = mktmp("t93-resolve-ws-");
		writeWorkspace(dir);
		const { deps } = resolveDeps({
			isTty: true,
			answers: [],
		});
		deps.ask = async () => {
			throw new Error("must not ask");
		};
		expect(await resolveStart(dir, deps)).toEqual({ kind: "serve", dir });
	});

	tposix("non-workspace off a TTY falls to no-workspace mode", async () => {
		const dir = mktmp("t93-resolve-empty-");
		const { deps, printed } = resolveDeps({ isTty: false });
		expect(await resolveStart(dir, deps)).toEqual({ kind: "no-workspace" });
		expect(printed.join("\n")).toMatch(/not a workspace/);
	});

	tposix("an explicit non-workspace dir off a TTY aborts", async () => {
		// sol review of T93: a named dir that is not a workspace must
		// not silently swap to no-workspace mode (operator CDB, cwd root).
		const dir = mktmp("t93-resolve-explicit-");
		const { deps, printed } = resolveDeps({ isTty: false });
		const res = await resolveStart(dir, { ...deps, explicit: true });
		expect(res.kind).toBe("abort");
		expect(printed.join("\n")).toMatch(/routeros-muse init/);
	});

	tposix("choice 1 inits here and registers", async () => {
		const dir = mktmp("t93-resolve-init-");
		const { deps, printed } = resolveDeps({ isTty: true, answers: ["1"] });
		const res = await resolveStart(dir, deps);
		expect(res).toEqual({ kind: "serve", dir });
		expect(nodeFs.existsSync(path.join(dir, "workspace.toml"))).toBe(true);
		expect(nodeFs.existsSync(path.join(dir, "device.cdb"))).toBe(true);
		expect(nodeFs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toContain(
			path.basename(dir),
		);
		const reg = readRegistry(deps.registryFile);
		expect(reg.entries.map((e) => e.path)).toContain(dir);
		expect(printed.join("\n")).toMatch(/workspace ready/);
	});

	tposix("choice 2 picks a registered workspace", async () => {
		const live = mktmp("t93-resolve-live-");
		writeWorkspace(live);
		nodeFs.writeFileSync(path.join(live, "device.cdb"), "stub");
		const { deps } = resolveDeps({ isTty: true, answers: ["2", "1"] });
		registerWorkspace(deps.registryFile, "live", live);
		registerWorkspace(deps.registryFile, "dead", path.join(live, "gone"));
		const res = await resolveStart(mktmp("t93-resolve-pick-"), deps);
		expect(res).toEqual({ kind: "serve", dir: live });
	});

	tposix("choice 2 with an empty registry aborts", async () => {
		const { deps } = resolveDeps({ isTty: true, answers: ["2"] });
		const res = await resolveStart(mktmp("t93-resolve-noreg-"), deps);
		expect(res.kind).toBe("abort");
	});

	tposix("choice 2 refuses a dead entry", async () => {
		const { deps } = resolveDeps({ isTty: true, answers: ["2", "1"] });
		registerWorkspace(deps.registryFile, "dead", "/nonexistent-t93-dead");
		const res = await resolveStart(mktmp("t93-resolve-dead-"), deps);
		expect(res.kind).toBe("abort");
		if (res.kind === "abort") expect(res.why).toMatch(/not a workspace/);
	});

	tposix("choice 3 opens the browser picker", async () => {
		const { deps } = resolveDeps({ isTty: true, answers: ["3"] });
		expect(await resolveStart(mktmp("t93-resolve-nows-"), deps)).toEqual({
			kind: "no-workspace",
		});
	});

	tposix("a bad choice aborts", async () => {
		const { deps } = resolveDeps({ isTty: true, answers: ["bogus"] });
		const res = await resolveStart(mktmp("t93-resolve-bad-"), deps);
		expect(res.kind).toBe("abort");
	});

	tposix("invalid workspace prints reasons and skips init", async () => {
		const dir = mktmp("t93-resolve-invalid-");
		nodeFs.writeFileSync(path.join(dir, "workspace.toml"), "home = [\n");
		const { deps, printed } = resolveDeps({ isTty: true, answers: ["3"] });
		expect(await resolveStart(dir, deps)).toEqual({ kind: "no-workspace" });
		expect(printed.join("\n")).toMatch(/does not parse/);
		expect(printed.join("\n")).not.toMatch(/1\) init/);
	});
});

describe("runInit", () => {
	tposix("inits an empty dir and registers it", async () => {
		const dir = mktmp("t93-init-ok-");
		const printed: string[] = [];
		const dh = mktmp("t93-init-dh-");
		const res = await runInit(dir, "minimal", {
			print: (line) => printed.push(line),
			registryFile: registryFile(dh),
			env: toolEnv(stubCentrsBin()),
		});
		expect(res).toEqual({ ok: true, dir });
		expect(nodeFs.existsSync(path.join(dir, "workspace.toml"))).toBe(true);
		expect(readRegistry(registryFile(dh)).entries.length).toBe(1);
		expect(printed.join("\n")).toMatch(/workspace ready/);
	});

	tposix("network template inits too", async () => {
		const dir = mktmp("t93-init-net-");
		const dh = mktmp("t93-init-netdh-");
		const res = await runInit(dir, "network", {
			print: () => {},
			registryFile: registryFile(dh),
			env: toolEnv(stubCentrsBin()),
		});
		expect(res).toEqual({ ok: true, dir });
		expect(nodeFs.existsSync(path.join(dir, "START-HERE.md"))).toBe(true);
		expect(nodeFs.existsSync(path.join(dir, "template.toml"))).toBe(false);
	});

	tposix("conflicts list and nothing is written", async () => {
		const dir = mktmp("t93-init-clobber-");
		nodeFs.writeFileSync(path.join(dir, "AGENTS.md"), "mine\n");
		const printed: string[] = [];
		const dh = mktmp("t93-init-clobberdh-");
		const res = await runInit(dir, "minimal", {
			print: (line) => printed.push(line),
			registryFile: registryFile(dh),
			env: toolEnv(stubCentrsBin()),
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.why).toMatch(/AGENTS\.md/);
		expect(nodeFs.readdirSync(dir)).toEqual(["AGENTS.md"]);
		expect(readRegistry(registryFile(dh)).entries.length).toBe(0);
	});
});

// code exec legs need a present+authed muse (else checkAgent stops by
// design); mirror the agent heuristic synchronously for the skip.
function museUsable(): boolean {
	if (process.env["META_API_KEY"]?.trim()) return true;
	try {
		return nodeFs.readFileSync(museAuthFile(), "utf8").trim().length > 2;
	} catch {
		return false;
	}
}
const tcode = POSIX && museUsable() ? test : test.skip;

describe("runCode", () => {
	tcode("print-only never execs", async () => {
		const dir = mktmp("t93-code-print-");
		const installed = await detectInstalled(toolEnv(toolBinDir()));
		// A missing tool stops at pins (by design) instead of exec'ing.
		if (!installed.quickchr || !installed.centrs || !installed.rosetta) {
			writeWorkspace(dir);
			let execs = 0;
			await expect(
				runCode(
					{ dir, yes: true, printOnly: true, passthrough: [] },
					{
						exec: async () => {
							execs++;
							throw new Error("must not exec");
						},
					},
				),
			).rejects.toThrow(Stop);
			expect(execs).toBe(0);
			return;
		}
		writeWorkspace(dir, {
			quickchr: installed.quickchr,
			centrs: installed.centrs,
			rosetta: installed.rosetta,
		});
		let execs = 0;
		await runCode(
			{
				dir,
				yes: true,
				printOnly: true,
				passthrough: ["--yolo"],
			},
			{
				exec: async () => {
					execs++;
					throw new Error("must not exec");
				},
				twins: async () => ({
					capable: false,
					detail: "stub",
					defined: null,
					running: null,
				}),
				lan: async () => ({ reachable: false, via: [] }),
			},
		);
		expect(execs).toBe(0);
	});

	tcode("exec receives the passthrough verbatim", async () => {
		const dir = mktmp("t93-code-exec-");
		const installed = await detectInstalled(toolEnv(toolBinDir()));
		const seen: { dir: string; args: string[] }[] = [];
		if (!installed.quickchr || !installed.centrs || !installed.rosetta) {
			writeWorkspace(dir);
			await expect(
				runCode(
					{ dir, yes: true, printOnly: false, passthrough: ["-c"] },
					{
						exec: async (d, a) => {
							seen.push({ dir: d, args: a });
							throw new Error("exec-spy");
						},
					},
				),
			).rejects.toThrow(Stop);
			expect(seen).toEqual([]);
			return;
		}
		writeWorkspace(dir, {
			quickchr: installed.quickchr,
			centrs: installed.centrs,
			rosetta: installed.rosetta,
		});
		await expect(
			runCode(
				{ dir, yes: true, printOnly: false, passthrough: ["-c", "--yolo"] },
				{
					exec: async (d, a) => {
						seen.push({ dir: d, args: a });
						throw new Error("exec-spy");
					},
					twins: async () => ({
						capable: false,
						detail: "stub",
						defined: null,
						running: null,
					}),
					lan: async () => ({ reachable: false, via: [] }),
				},
			),
		).rejects.toThrow("exec-spy");
		expect(seen).toEqual([{ dir, args: ["-c", "--yolo"] }]);
	});
});

describe("runDoctor", () => {
	tposix("never execs muse and reports honestly", async () => {
		const dir = mktmp("t93-doctor-ws-");
		writeWorkspace(dir); // bogus exact pins: always mismatched, no network
		const bin = mktmp("t93-doctor-bin-");
		const sentinel = path.join(bin, "muse-ran");
		writeShim(bin, "muse", `: > "${sentinel}"`);
		const savedPath = process.env["PATH"];
		process.env["PATH"] = `${bin}${path.delimiter}${savedPath ?? ""}`;
		try {
			const report = await runDoctor(dir, {
				twins: async () => ({
					capable: false,
					detail: "stub",
					defined: null,
					running: null,
				}),
				lan: async () => ({ reachable: false, via: [] }),
			});
			expect(report.ok).toBe(false);
			expect(report.failures.some((f) => f.startsWith("pins:"))).toBe(true);
			expect(nodeFs.existsSync(sentinel)).toBe(false);
		} finally {
			if (savedPath === undefined) delete process.env["PATH"];
			else process.env["PATH"] = savedPath;
		}
	});

	tposix("an invalid workspace fails the report, not the run", async () => {
		const dir = mktmp("t93-doctor-badws-");
		const report = await runDoctor(dir, {
			twins: async () => ({
				capable: true,
				detail: "stub",
				defined: 1,
				running: 0,
			}),
			lan: async () => ({ reachable: true, via: ["stub"] }),
		});
		expect(report.ok).toBe(false);
		expect(report.failures).toContain("workspace (invalid)");
	});
});
