// Process helpers: sync presence checks, async runs with timeouts.

export type RunResult = {
	ok: boolean;
	exit: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
};

/**
 * Sync PATH presence check. Pass the explicit spawn env when the
 * caller fronts PATH (toolEnv): the ambient check would answer for
 * the wrong PATH.
 */
export function have(cmd: string, env?: Record<string, string>): boolean {
	const withEnv = env ? { env } : {};
	try {
		const probe =
			process.platform === "win32"
				? Bun.spawnSync(["cmd.exe", "/c", "where", cmd], {
						stdout: "pipe",
						stderr: "pipe",
						...withEnv,
					})
				: Bun.spawnSync(["sh", "-c", `command -v ${cmd}`], {
						stdout: "pipe",
						stderr: "pipe",
						...withEnv,
					});
		return probe.exitCode === 0;
	} catch {
		// Unresolvable shell under a narrowed PATH: nothing is present.
		return false;
	}
}

/**
 * Run argv with captured output and a kill deadline. Bun.spawn inherits the
 * startup environment snapshot: later process.env mutations do NOT reach
 * the child — pass env explicitly when a call needs a modified value.
 */
export async function run(
	cmd: string[],
	opts?: { timeoutMs?: number; cwd?: string; env?: Record<string, string> },
): Promise<RunResult> {
	const timeoutMs = opts?.timeoutMs ?? 30_000;
	const proc = Bun.spawn(cmd, {
		stdout: "pipe",
		stderr: "pipe",
		cwd: opts?.cwd,
		...(opts?.env ? { env: opts.env } : {}),
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, timeoutMs);
	try {
		const [stdout, stderr, exit] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { ok: exit === 0, exit, stdout, stderr, timedOut };
	} finally {
		clearTimeout(timer);
	}
}

/** Run a shell snippet (doctor detects); sh on unix, cmd on windows. */
export async function runShell(
	script: string,
	opts?: { timeoutMs?: number; cwd?: string },
): Promise<RunResult> {
	const cmd =
		process.platform === "win32"
			? ["cmd.exe", "/c", script]
			: ["sh", "-c", script];
	return run(cmd, opts);
}
