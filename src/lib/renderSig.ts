// Render-job provenance (T83 followup): an HMAC over a canonical job
// payload, so the scripts tier is granted only for artifacts a real
// render job wrote and nobody has since edited. A forged job.json
// (or a flipped tier, or edited HTML) fails verification and the
// artifact opens static with no "render job" label.
//
// This defends against forged or edited metadata in the workspace,
// NOT against a same-user shell reading the key: the key lives in
// the same data home as registry.toml (mode 0600), readable by the
// user the server runs as.
import * as nodeCrypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { dataHomeDir } from "./registry";

/** The provenance key file: beside registry.toml in the XDG data home. */
export function renderKeyFile(dataHome?: string): string {
	return path.join(dataHomeDir(dataHome), "routeros-muse", "render.key");
}

/**
 * Read the key, creating a 32-byte random one (mode 0600) on first
 * use. A present-but-wrong-length file is replaced: old signatures
 * stop verifying (fail closed to static) and the next job signs
 * fresh.
 */
export function ensureRenderKey(dataHome?: string): Buffer {
	const file = renderKeyFile(dataHome);
	try {
		const key = nodeFs.readFileSync(file);
		if (key.length === 32) return key;
	} catch {
		// Missing: fall through and create.
	}
	const key = nodeCrypto.randomBytes(32);
	nodeFs.mkdirSync(path.dirname(file), { recursive: true });
	nodeFs.writeFileSync(file, key, { mode: 0o600 });
	return key;
}

/** Peek at the key without creating it; null when absent/unusable. */
export function readRenderKey(dataHome?: string): Buffer | null {
	try {
		const key = nodeFs.readFileSync(renderKeyFile(dataHome));
		return key.length === 32 ? key : null;
	} catch {
		return null;
	}
}

/** sha256 of bytes, hex. */
export function sha256Hex(data: Buffer | string): string {
	return nodeCrypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Canonical JSON of the signed payload: fixed field order,
 * filenames sorted, no whitespace. Both sides must build the
 * identical string for the HMAC to verify.
 */
export function canonicalJobPayload(
	jobDirRel: string,
	tier: string,
	files: Record<string, string>,
): string {
	const names = Object.keys(files).sort();
	const inner = names
		.map((n) => `${JSON.stringify(n)}:${JSON.stringify(files[n])}`)
		.join(",");
	return `{"files":{${inner}},"jobDirRel":${JSON.stringify(jobDirRel)},"tier":${JSON.stringify(tier)}}`;
}

/** Hex HMAC-SHA256 of the canonical payload. */
export function signJobPayload(key: Buffer, canonical: string): string {
	return nodeCrypto
		.createHmac("sha256", key)
		.update(canonical, "utf8")
		.digest("hex");
}

/** Constant-time compare of the stored hex against the recomputed one. */
export function verifyJobSignature(
	key: Buffer,
	canonical: string,
	sigHex: string,
): boolean {
	const want = signJobPayload(key, canonical);
	const a = Buffer.from(want, "utf8");
	const b = Buffer.from(sigHex.trim(), "utf8");
	return a.length === b.length && nodeCrypto.timingSafeEqual(a, b);
}
