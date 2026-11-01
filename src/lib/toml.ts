// TOML parsing via Bun's built-in parser.

export type TomlResult =
	| { ok: true; value: Record<string, unknown> }
	| { ok: false; error: string };

export function parseToml(text: string): TomlResult {
	try {
		const value = Bun.TOML.parse(text) as Record<string, unknown>;
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			return { ok: false, error: "top level is not a table" };
		}
		return { ok: true, value };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: msg.split("\n")[0] ?? "unparseable" };
	}
}
