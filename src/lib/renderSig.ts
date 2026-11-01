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

/** Provenance keys are 32 bytes, no more, no less. */
const RENDER_KEY_BYTES = 32;

/** True when the mode carries permission bits outside owner read+write. */
function keyModeIsWide(mode: number): boolean {
	return (mode & 0o7777 & ~0o600) !== 0;
}

/**
 * Read + validate an existing key file: a regular file (never a
 * symlink), mode repaired to 0600, 32 bytes. Null on anything else,
 * missing included — the verify path fails closed to static.
 */
function readKeyFileValidated(file: string): Buffer | null {
	let lst: nodeFs.Stats;
	try {
		lst = nodeFs.lstatSync(file);
	} catch {
		return null;
	}
	if (lst.isSymbolicLink() || !lst.isFile()) return null;
	if (keyModeIsWide(lst.mode)) {
		try {
			nodeFs.chmodSync(file, 0o600);
		} catch {
			return null;
		}
	}
	let key: Buffer;
	try {
		key = nodeFs.readFileSync(file);
	} catch {
		return null;
	}
	return key.length === RENDER_KEY_BYTES ? key : null;
}

/** Peek at the key without creating it; null when absent/unusable. */
export function readRenderKey(dataHome?: string): Buffer | null {
	return readKeyFileValidated(renderKeyFile(dataHome));
}

/**
 * Read the key, creating it on first use. Fail-closed: a symlink or
 * non-regular file is never used or written through, a wide mode is
 * repaired to 0600 first, and a wrong-length file is left alone —
 * each throws a clear error telling the owner to delete the file to
 * reprovision. Creation is atomic (exclusive tmp + link), so
 * concurrent first signers agree on one key.
 */
export function ensureRenderKey(dataHome?: string): Buffer {
	return ensureKeyFile(renderKeyFile(dataHome));
}

function ensureKeyFile(file: string): Buffer {
	let lst: nodeFs.Stats | null = null;
	try {
		lst = nodeFs.lstatSync(file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
			throw new Error(
				`render key unreadable: ${file}: ${(err as Error).message} (delete it to reprovision)`,
			);
		}
	}
	if (lst === null) return createKeyFile(file);
	if (lst.isSymbolicLink()) {
		throw new Error(
			`render key is a symlink, refusing to use or overwrite it: ${file} (delete it to reprovision)`,
		);
	}
	if (!lst.isFile()) {
		throw new Error(
			`render key is not a regular file, refusing to use it: ${file} (delete it to reprovision)`,
		);
	}
	if (keyModeIsWide(lst.mode)) {
		try {
			nodeFs.chmodSync(file, 0o600);
		} catch (err) {
			throw new Error(
				`render key has wide permissions and chmod to 0600 failed, refusing to use it: ${file}: ${(err as Error).message}`,
			);
		}
	}
	let key: Buffer;
	try {
		key = nodeFs.readFileSync(file);
	} catch (err) {
		throw new Error(
			`render key unreadable: ${file}: ${(err as Error).message} (delete it to reprovision)`,
		);
	}
	if (key.length !== RENDER_KEY_BYTES) {
		throw new Error(
			`render key has wrong length ${key.length} (want ${RENDER_KEY_BYTES}), refusing to overwrite it: ${file} (delete it to reprovision)`,
		);
	}
	return key;
}

/**
 * Atomic first creation: an exclusively-created 0600 tmp next to the
 * key, then a link onto the key name. The link decides the winner:
 * EEXIST means another signer won, so drop the tmp and read theirs.
 */
function createKeyFile(file: string): Buffer {
	nodeFs.mkdirSync(path.dirname(file), { recursive: true });
	const dir = path.dirname(file);
	const key = nodeCrypto.randomBytes(RENDER_KEY_BYTES);
	for (let attempt = 0; attempt < 5; attempt++) {
		const tmp = path.join(
			dir,
			`.render.key.tmp.${process.pid}.${nodeCrypto.randomBytes(8).toString("hex")}`,
		);
		let fd: number;
		try {
			fd = nodeFs.openSync(tmp, "wx", 0o600);
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === "EEXIST") continue;
			throw err;
		}
		try {
			let off = 0;
			while (off < key.length) {
				const n = nodeFs.writeSync(fd, key, off, key.length - off);
				if (n <= 0) throw new Error(`short write to ${tmp}`);
				off += n;
			}
			nodeFs.closeSync(fd);
		} catch (err) {
			nodeFs.rmSync(tmp, { force: true });
			throw err;
		}
		try {
			nodeFs.linkSync(tmp, file);
		} catch (err) {
			nodeFs.rmSync(tmp, { force: true });
			if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
				const theirs = readKeyFileValidated(file);
				if (!theirs) {
					throw new Error(
						`render key appeared but is unusable: ${file} (delete it to reprovision)`,
					);
				}
				return theirs;
			}
			throw err;
		}
		nodeFs.rmSync(tmp, { force: true });
		return key;
	}
	throw new Error(
		`render key creation collided repeatedly, refusing to proceed: ${file}`,
	);
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
