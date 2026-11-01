// Mode A launch: `muse` in the workspace directory. --yolo
// forwards to this launch only (the agent's approval mode), never
// to installs or sudo.

export function launchArgs(yolo: boolean): string[] {
	return yolo ? ["muse", "--yolo"] : ["muse"];
}

export function launchLine(yolo: boolean): string {
	return launchArgs(yolo).join(" ");
}

export async function launchAgent(
	wsDir: string,
	yolo: boolean,
	env?: Record<string, string>,
): Promise<never> {
	const proc = Bun.spawn(launchArgs(yolo), {
		cwd: wsDir,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
		...(env ? { env } : {}),
	});
	const exit = await proc.exited;
	process.exit(exit);
}
