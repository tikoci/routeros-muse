// Code launch: `muse` in the workspace directory, with the code
// passthrough appended verbatim (--yolo included: it is muse's own
// approval flag here, never ours).

export function launchArgs(extra: string[] = []): string[] {
	return ["muse", ...extra];
}

export function launchLine(extra: string[] = []): string {
	return launchArgs(extra)
		.map((a) => (a.includes(" ") ? JSON.stringify(a) : a))
		.join(" ");
}

export async function launchAgent(
	wsDir: string,
	extra: string[] = [],
	env?: Record<string, string>,
): Promise<never> {
	const proc = Bun.spawn(launchArgs(extra), {
		cwd: wsDir,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
		...(env ? { env } : {}),
	});
	const exit = await proc.exited;
	process.exit(exit);
}
