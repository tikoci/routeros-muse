// Browser open (T93 start): per-platform open command, injected for
// tests. Linux opens only with a display (DISPLAY or
// WAYLAND_DISPLAY); without one the caller prints the URL instead.
export type OpenDeps = {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	spawn?: (cmd: string[]) => void;
};

/** The open argv for url, or null when opening is not possible. */
export function browserOpenCommand(
	url: string,
	deps?: OpenDeps,
): string[] | null {
	const platform = deps?.platform ?? process.platform;
	if (platform === "darwin") return ["open", url];
	if (platform === "win32") return ["cmd", "/c", "start", url];
	const env = deps?.env ?? process.env;
	if (env["DISPLAY"] || env["WAYLAND_DISPLAY"]) return ["xdg-open", url];
	return null;
}

/**
 * Fire-and-forget open. True when a command was spawned; false when
 * there is no way to open (Linux without a display).
 */
export function openBrowser(url: string, deps?: OpenDeps): boolean {
	const cmd = browserOpenCommand(url, deps);
	if (!cmd) return false;
	const spawn =
		deps?.spawn ??
		((c: string[]) => {
			Bun.spawn(c, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
		});
	spawn(cmd);
	return true;
}
