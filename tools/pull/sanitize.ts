// sanitize.ts — pure functions for pull: redact, volatile-strip, hash, serial gate.
// Zero deps. Covered by anchor tests in pull.test.ts.

export interface AttemptFile {
	path: string;
	sha256: string;
	bytes: number;
}
export interface Manifest {
	target: string;
	serial: string;
	capturedAt: string;
	tools: { centrs: string; quickchr: string };
	files: AttemptFile[];
	status: "ok" | "partial" | "refused";
	notes: string[];
}

// Export lines with secret-bearing keys get value-redacted. Deliberately
// narrow: password/passwd/secret/passphrase/private-key/community.
const SECRET_KEY =
	/(password|passwd|secret|passphrase|private-key|community)=("[^"]*"|\S+)/gi;
// /container env values whose NAME looks like a secret (export prints them clear).
const ENV_NAME = /^(.*name=)(("[^"]*")|\S+)(.*value=)("[^"]*"|\S+)(.*)$/i;
const ENV_SECRET_NAME = /(pass|secret|token|key|pwd|credential)/i;

export function redactExport(text: string): string {
	return text
		.split("\n")
		.map((line) => {
			let out = line.replace(SECRET_KEY, '$1"[redacted]"');
			if (line.includes("/container")) {
				const m = out.match(ENV_NAME);
				if (m && ENV_SECRET_NAME.test(m[2] ?? ""))
					out = `${m[1]}${m[2]}${m[4]}"[redacted]"${m[6]}`;
				// Inline env="K1=V1,K2=V2" on /container/add lines (e.g. TUNNEL_TOKEN).
				out = out.replace(/env="([^"]*)"/g, (_full, inner: string) => {
					const red = inner
						.split(",")
						.map((pair) => {
							const eq = pair.indexOf("=");
							if (eq > 0 && ENV_SECRET_NAME.test(pair.slice(0, eq)))
								return `${pair.slice(0, eq + 1)}[redacted]`;
							return pair;
						})
						.join(",");
					return `env="${red}"`;
				});
			}
			return out;
		})
		.join("\n");
}

// First header line carries a timestamp; keep version, drop datetime for stable diffs.
export function stableExportHeader(text: string): string {
	return text
		.split("\n")
		.map((line) =>
			line.replace(
				/^# \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} by RouterOS /,
				"# by RouterOS ",
			),
		)
		.join("\n");
}

// JSON keys whose values change with time/counters rather than config.
const VOLATILE = new Set([
	"uptime",
	"cpu-load",
	"free-memory",
	"free-hdd-space",
	"write-sect-since-reboot",
	"write-sect-total",
	"rx-byte",
	"tx-byte",
	"rx-packet",
	"tx-packet",
	"rx-drop",
	"tx-drop",
	"rx-error",
	"tx-error",
	"last-link-up-time",
	"last-seen",
	"last-activity",
	"link-downs",
	"creation-time",
]);

export function stripVolatile(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripVolatile);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (!VOLATILE.has(k)) out[k] = stripVolatile(v);
		}
		return out;
	}
	return value;
}

export function sha256Hex(text: string): string {
	const h = new Bun.CryptoHasher("sha256");
	h.update(text);
	return h.digest("hex");
}

/** Serial gate: returns "ok" to proceed, or a refusal reason. */
export function checkSerial(
	previous: Manifest | null,
	current: string,
): string | null {
	if (!previous) return null;
	if (previous.serial !== current) {
		return `serial mismatch: expected ${previous.serial} (slot record), got ${current} — refused, nothing published`;
	}
	return null;
}
