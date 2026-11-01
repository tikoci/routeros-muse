// Step 5: capability probe. Shell + tool versions vs pins (already
// known), twin reachability (quickchr doctor/list), LAN router
// reachability (MNDP discover, plus a --router TCP probe). Prints the
// mode: full / twin-only / real-box-only / design-only.
//
// twin-only is a fourth edge T29's three modes do not name: twins
// reachable, LAN not. Twins execute real proofs, so it is neither
// full nor design-only; it gets its own name rather than a lie.

import { have, run } from "../lib/run";

export type Mode = "full" | "twin-only" | "real-box-only" | "design-only";

export function mapMode(twin: boolean, lan: boolean): Mode {
	if (twin && lan) return "full";
	if (twin && !lan) return "twin-only";
	if (!twin && lan) return "real-box-only";
	return "design-only";
}

export type TwinReport = {
	capable: boolean;
	detail: string;
	defined: number | null;
	running: number | null;
};

function checkDetail(checks: unknown, label: string): string | null {
	if (!Array.isArray(checks)) return null;
	const hit = checks.find(
		(c) => (c as Record<string, unknown>)["label"] === label,
	) as Record<string, unknown> | undefined;
	const detail = hit?.["detail"];
	return typeof detail === "string" ? detail : null;
}

export async function probeTwins(
	env?: Record<string, string>,
): Promise<TwinReport> {
	if (!have("quickchr", env)) {
		return {
			capable: false,
			detail: "quickchr not installed",
			defined: null,
			running: null,
		};
	}
	const d = await run(["quickchr", "doctor", "--json"], {
		timeoutMs: 60_000,
		env,
	});
	let ok = false;
	let accel: string | null = null;
	let machines: string | null = null;
	try {
		const doc = JSON.parse(d.stdout) as Record<string, unknown>;
		ok = doc["ok"] === true;
		accel = checkDetail(doc["checks"], "Acceleration");
		machines = checkDetail(doc["checks"], "Machines");
	} catch {
		ok = false;
	}
	if (!ok) {
		return {
			capable: false,
			detail: "quickchr doctor reports not-ok",
			defined: null,
			running: null,
		};
	}
	// Running/defined counts, best effort from `list --json`.
	let defined: number | null = null;
	let running: number | null = null;
	const l = await run(["quickchr", "list", "--json"], {
		timeoutMs: 30_000,
		env,
	});
	try {
		const list = JSON.parse(l.stdout) as unknown[];
		if (Array.isArray(list)) {
			defined = list.length;
			const runningCount = list.filter((m) => {
				const r = m as Record<string, unknown>;
				return (
					r["running"] === true ||
					(typeof r["pid"] === "number" && r["pid"] > 0)
				);
			}).length;
			running = runningCount;
		}
	} catch {
		// Fall back to the doctor's "N instances (M running)" line.
		const m = machines?.match(/(\d+) instances?\s*\((\d+) running/);
		if (m) {
			defined = Number(m[1]);
			running = Number(m[2]);
		}
	}
	if (defined === null && machines) {
		const m = machines.match(/(\d+) instances?\s*\((\d+) running/);
		if (m) {
			defined = Number(m[1]);
			running = Number(m[2]);
		}
	}
	const detail = accel ? `doctor ok (${accel})` : "doctor ok";
	return { capable: true, detail, defined, running };
}

export type LanReport = {
	reachable: boolean;
	via: string[];
};

export async function probeMndp(
	env?: Record<string, string>,
): Promise<{ count: number }> {
	if (!have("centrs", env)) return { count: 0 };
	const r = await run(["centrs", "discover", "--timeout", "8s", "--json"], {
		timeoutMs: 30_000,
		env,
	});
	try {
		const doc = JSON.parse(r.stdout) as Record<string, unknown>;
		const data = doc["data"] as Record<string, unknown> | undefined;
		const count = data?.["count"];
		return { count: typeof count === "number" ? count : 0 };
	} catch {
		return { count: 0 };
	}
}

export function parseRouterFlag(flag: string): {
	host: string;
	ports: number[];
} {
	const m = flag.match(/^\[(.+)\]:(\d+)$/) ?? flag.match(/^(.+):(\d+)$/);
	if (m) {
		const host = m[1];
		const port = m[2];
		if (host !== undefined && port !== undefined)
			return { host, ports: [Number(port)] };
	}
	return { host: flag, ports: [8728, 8291, 22] };
}

/** TCP connect probe with a short deadline. Never prints the host. */
export async function tcpProbe(
	host: string,
	port: number,
	timeoutMs = 3000,
): Promise<boolean> {
	try {
		const socket = (await Promise.race([
			Bun.connect({
				hostname: host,
				port,
				socket: {
					data() {},
					open() {},
					close() {},
					error() {},
				},
			}),
			new Promise<null>((resolve) =>
				setTimeout(() => resolve(null), timeoutMs),
			),
		])) as { end: () => void } | null;
		if (!socket) return false;
		try {
			socket.end();
		} catch {
			// Already closed; the connect itself is the signal.
		}
		return true;
	} catch {
		return false;
	}
}

export async function probeLan(
	routerFlag?: string,
	env?: Record<string, string>,
): Promise<LanReport> {
	const via: string[] = [];
	const mndp = await probeMndp(env);
	if (mndp.count > 0)
		via.push(`MNDP (${mndp.count} neighbor${mndp.count === 1 ? "" : "s"})`);
	if (routerFlag) {
		const { host, ports } = parseRouterFlag(routerFlag);
		for (const port of ports) {
			if (await tcpProbe(host, port)) {
				via.push(`--router port ${port} open`);
				break;
			}
		}
	}
	return { reachable: via.length > 0, via };
}
