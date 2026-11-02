// Approval-policy pre-seeding (T101, D43): our designed read set as
// `shell_command_argv_prefix` allow rules in the user's muse
// approval-policy.json (schema v2), scoped to the workspace's
// absolute root, plus network allow rules for the workspace's
// router.toml device hosts (phase 1.5: shape from the live probe).
//
// Every rule we write carries reason "routeros-muse:seed", and only
// entries carrying that tag are ever modified or removed — foreign
// entries (and unknown fields inside them) round-trip untouched.
//
// Write safety mirrors src/lib/settings.ts (T50): lstat the chain
// and refuse symlinks; an exclusively created sibling temp,
// written fully, then rename. Concurrent writers exist (other muse
// sessions persisting "Always allow"), so the flow is read, merge,
// write-temp, re-read, rename-or-retry (initial attempt plus up to
// 3 retries), then an honest give-up that leaves the file alone.
import * as nodeCrypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Tag on every rule we write; the only rules we ever touch. */
export const PREALLOW_TAG = "routeros-muse:seed";

/** The only approval-policy schema we understand. */
export const POLICY_SCHEMA_VERSION = 2;

/**
 * Designed read set, one argv prefix per rule (D43): two-word
 * prefixes for the trilogy tools so sibling subcommands keep
 * prompting (centrs execute stays unlisted — --yes cannot be
 * excluded — and bare binaries are never seeded), one-word
 * prefixes for the read-only coreutils.
 *
 * Rosetta: `browse` is the read path (agent runs
 * `rosetta browse --once ...` plus `rosetta --version`); `export`
 * writes a dataset dir and --setup/--refresh download, so those
 * stay prompting; the bare binary would free them all.
 */
export const READ_COMMANDS: string[][] = [
	["centrs", "retrieve"],
	["quickchr", "list"],
	["quickchr", "doctor"],
	["ls"],
	["cat"],
	["grep"],
	["find"],
	["rosetta", "browse"],
	["rosetta", "--help"],
	["rosetta", "--version"],
];

/** Explicit opt beats XDG_CONFIG_HOME beats ~/.config. */
export function configHomeDir(explicit?: string): string {
	if (explicit !== undefined) return explicit;
	return process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config");
}

/** The muse approval-policy file under a config home. Pure. */
export function policyFile(configHome?: string): string {
	return path.join(configHomeDir(configHome), "muse", "approval-policy.json");
}

/** Thrown when the policy chain holds a symlink (never followed). */
export class PolicySymlinkError extends Error {
	readonly link: string;
	constructor(link: string) {
		super(`refused: not following symlink at ${link}`);
		this.name = "PolicySymlinkError";
		this.link = link;
	}
}

/**
 * Narrow test seam for the policy write, mirroring SettingsFs:
 * lets tests script concurrent writers. Production callers leave
 * it unset and get node:fs straight through.
 */
export type PreallowFs = {
	readFileSync?: (file: string, encoding: "utf8") => string;
	openSync?: (p: string, flags: string, mode: number) => number;
	writeSync?: (
		fd: number,
		buf: Buffer,
		offset: number,
		length: number,
	) => number;
	fsyncSync?: (fd: number) => void;
	closeSync?: (fd: number) => void;
	renameSync?: (tmp: string, file: string) => void;
	unlinkSync?: (p: string) => void;
};

export type EnsureArgs = {
	configHome?: string;
	workspaceRoot: string;
	/** Phase 1.5 wires these into network rules; until then reported only. */
	hosts?: string[];
	/** False removes our tagged rules for this workspace instead. */
	enabled: boolean;
};

export type EnsureResult = {
	changed: boolean;
	enabled: boolean;
	seededCommands: string[][];
	seededHosts: string[];
	warnings: string[];
};

/**
 * lstat the <configHome>/muse dir and the policy file. Returns the
 * offending path when either is a symlink, else null. Absent
 * components are fine (not symlinks; creation follows). The
 * config-home root itself is trusted, exactly like settings.ts
 * trusts the data-home root.
 */
function chainSymlink(file: string): string | null {
	for (const p of [path.dirname(file), file]) {
		try {
			if (nodeFs.lstatSync(p).isSymbolicLink()) return p;
		} catch {
			// Absent: nothing to follow.
		}
	}
	return null;
}

/**
 * Write content to an exclusively created sibling temp
 * (approval-policy.json.<pid>.<rand>.tmp, O_EXCL, mode 0600) and
 * return its path; the caller renames (commit) or unlinks
 * (abort). Loops until every byte lands, fsyncs, closes in a
 * finally, and on ANY error unlinks the temp and rethrows.
 */
function writeTempExclusive(
	file: string,
	content: string,
	fs?: PreallowFs,
): string {
	const openSync = fs?.openSync ?? nodeFs.openSync;
	const writeSync =
		fs?.writeSync ??
		((fd: number, buf: Buffer, offset: number, length: number): number =>
			nodeFs.writeSync(fd, buf, offset, length, null));
	const fsyncSync = fs?.fsyncSync ?? nodeFs.fsyncSync;
	const closeSync = fs?.closeSync ?? nodeFs.closeSync;
	const unlinkSync = fs?.unlinkSync ?? nodeFs.unlinkSync;
	const rand = nodeCrypto.randomBytes(8).toString("hex");
	const tmp = `${file}.${process.pid}.${rand}.tmp`;
	const fd = openSync(tmp, "wx", 0o600);
	try {
		try {
			const buf = Buffer.from(content, "utf8");
			let off = 0;
			while (off < buf.length) {
				const n = writeSync(fd, buf, off, buf.length - off);
				if (n <= 0) {
					throw new Error(
						`short write on ${file}: wrote ${n} of ${buf.length - off} bytes`,
					);
				}
				off += n;
			}
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		return tmp;
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// Best effort: the temp may already be gone.
		}
		throw err;
	}
}

type PolicyEntry = Record<string, unknown>;

function isRecord(v: unknown): v is PolicyEntry {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Ours to touch: an object whose reason is exactly our tag. */
function isOurs(entry: unknown): entry is PolicyEntry {
	return isRecord(entry) && entry["reason"] === PREALLOW_TAG;
}

function shellRoot(entry: PolicyEntry): string | null {
	const rule = entry["rule"];
	if (!isRecord(rule)) return null;
	if (rule["kind"] !== "shell_command_argv_prefix") return null;
	return typeof rule["workspace_root"] === "string"
		? (rule["workspace_root"] as string)
		: null;
}

/** A workspace root counts as live when it is still a directory. */
function rootAlive(root: string): boolean {
	try {
		return nodeFs.statSync(root).isDirectory();
	} catch {
		return false;
	}
}

function shellEntry(prefix: string[], workspaceRoot: string): PolicyEntry {
	// Key order matches muse's own writer (P1 capture).
	return {
		effect: "allow",
		durability: "local_persistent",
		rule: {
			kind: "shell_command_argv_prefix",
			argv_prefix: [...prefix],
			workspace_root: workspaceRoot,
		},
		reason: PREALLOW_TAG,
	};
}

/** Trim, drop empties, dedupe (first-seen order). */
export function normalizeHosts(hosts: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const h of hosts) {
		const t = h.trim();
		if (!t || seen.has(t)) continue;
		seen.add(t);
		out.push(t);
	}
	return out;
}

const MAX_ATTEMPTS = 4; // Initial attempt plus up to 3 retries.

/**
 * Ensure this workspace's pre-seeded rules in approval-policy.json.
 *
 * Enabled: the current root holds exactly our shell set (stale
 * entries from older seed sets are replaced, never merged), our
 * tagged shell rules for roots that no longer exist are pruned,
 * our tagged rules for other live roots are kept, and every
 * foreign entry is preserved in place. Disabled: our tagged rules
 * for this root are removed (dead-root pruning still applies).
 *
 * No rewrite when nothing changed (byte-compare before writing).
 * An unknown schema_version or unparseable file skips with a
 * warning and leaves the bytes alone — never rewrite what we
 * don't understand. A symlink in the chain throws
 * PolicySymlinkError. A file that changes under every attempt
 * gives up with a warning after MAX_ATTEMPTS.
 */
export function ensurePreallowReads(
	args: EnsureArgs,
	fs?: PreallowFs,
): EnsureResult {
	const file = policyFile(args.configHome);
	const link = chainSymlink(file);
	if (link !== null) throw new PolicySymlinkError(link);
	nodeFs.mkdirSync(path.dirname(file), { recursive: true });
	const readFile: (file: string, encoding: "utf8") => string =
		fs?.readFileSync ?? ((f, e) => nodeFs.readFileSync(f, e));
	const renameSync = fs?.renameSync ?? nodeFs.renameSync;
	const unlinkSync = fs?.unlinkSync ?? nodeFs.unlinkSync;
	const desired: PolicyEntry[] = args.enabled
		? READ_COMMANDS.map((p) => shellEntry(p, args.workspaceRoot))
		: [];
	const seededCommands = args.enabled ? READ_COMMANDS.map((p) => [...p]) : [];
	const base: EnsureResult = {
		changed: false,
		enabled: args.enabled,
		seededCommands,
		seededHosts: [],
		warnings: [],
	};
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		let before: string | null;
		try {
			before = readFile(file, "utf8");
		} catch (err) {
			// Only a missing file starts empty; an unreadable one
			// (EACCES, EISDIR, ...) must never be replaced wholesale.
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			before = null;
		}
		let doc: { schema_version?: unknown; rules?: unknown } & PolicyEntry = {
			schema_version: POLICY_SCHEMA_VERSION,
			rules: [],
		};
		if (before !== null) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(before) as unknown;
			} catch {
				return {
					...base,
					warnings: [
						`not seeding ${file}: unparseable JSON (leaving it alone)`,
					],
				};
			}
			if (!isRecord(parsed) || !Array.isArray(parsed["rules"])) {
				return {
					...base,
					warnings: [
						`not seeding ${file}: expected {schema_version, rules[]} (leaving it alone)`,
					],
				};
			}
			if (parsed["schema_version"] !== POLICY_SCHEMA_VERSION) {
				return {
					...base,
					warnings: [
						`not seeding ${file}: schema_version ${JSON.stringify(parsed["schema_version"])} is not ${POLICY_SCHEMA_VERSION} (leaving it alone)`,
					],
				};
			}
			doc = parsed as typeof doc;
		}
		const rules = doc["rules"] as unknown[];
		const kept: PolicyEntry[] = [];
		for (const entry of rules) {
			if (!isOurs(entry)) {
				// Foreign or malformed: never ours to touch.
				kept.push(entry as PolicyEntry);
				continue;
			}
			const root = shellRoot(entry);
			if (root === null) {
				// Tagged but not a shell rule (a newer seed kind):
				// keep, never destroy data from a newer writer.
				kept.push(entry);
				continue;
			}
			if (root === args.workspaceRoot) continue; // Replaced by desired.
			if (rootAlive(root)) kept.push(entry); // Else pruned.
		}
		const next = [...kept, ...desired];
		if (JSON.stringify(next) === JSON.stringify(rules)) {
			return base;
		}
		// Serialization matches muse's own writer: 2-space indent,
		// trailing newline, schema_version first (P1 capture).
		const { schema_version: _v, rules: _r, ...rest } = doc;
		const content = `${JSON.stringify(
			{ schema_version: POLICY_SCHEMA_VERSION, ...rest, rules: next },
			null,
			2,
		)}\n`;
		const tmp = writeTempExclusive(file, content, fs);
		let after: string | null;
		try {
			after = readFile(file, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				try {
					unlinkSync(tmp);
				} catch {
					// Best effort.
				}
				throw err;
			}
			after = null;
		}
		if (after !== before) {
			// A concurrent writer landed between our read and our
			// rename: drop the temp and re-merge over their bytes.
			try {
				unlinkSync(tmp);
			} catch {
				// Best effort.
			}
			continue;
		}
		renameSync(tmp, file);
		return { ...base, changed: true };
	}
	return {
		...base,
		warnings: [
			`not seeding ${file}: changed under ${MAX_ATTEMPTS} attempts by a concurrent writer (leaving it alone)`,
		],
	};
}
