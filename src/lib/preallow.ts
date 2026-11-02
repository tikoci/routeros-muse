// Approval-policy pre-seeding (T101, D43/D44): our designed read
// set as `shell_command_argv_prefix` allow rules in OUR OWN muse
// approval-policy.json (schema v2, inside the private config home),
// scoped to the workspace's absolute root, plus network allow rules
// for the union of router.toml device hosts over every registered
// workspace (network rules are global, so ownership is the union —
// derived from registry.toml + router.toml files, never separate
// state).
//
// The shared ~/.config/muse is never written: auth reaches our
// workers through a symlink to the real auth.json, re-ensured on
// every spawn.
//
// Every rule we write carries reason "routeros-muse:seed", and only
// entries carrying that tag are ever modified or removed — foreign
// entries (and unknown fields inside them) round-trip untouched.
//
// Write safety mirrors src/lib/settings.ts (T50): lstat the chain
// and refuse symlinks; an exclusively created sibling temp,
// written fully, then rename. Concurrent writers exist (our own
// live muse sessions persisting "Always allow", plus our own
// server processes), so the flow is: take the cross-process lock
// (round 3, released in a finally), then read, merge, write-temp,
// re-read, rename-or-retry (initial attempt plus up to 3 retries),
// then an honest give-up that leaves the file alone.
import * as nodeCrypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readDevices } from "./fleet";
import { dataHomeDir } from "./registry";

/** Tag on every rule we write; the only rules we ever touch. */
export const PREALLOW_TAG = "routeros-muse:seed";

/** The only approval-policy schema we understand. */
export const POLICY_SCHEMA_VERSION = 2;

/**
 * Designed read set, one argv prefix per rule (D43 as amended
 * 2026-11-02): exactly two two-word prefixes, so sibling
 * subcommands keep prompting (centrs execute stays unlisted —
 * --yes cannot be excluded — and bare binaries are never seeded:
 * [quickchr] would also free `quickchr remove`).
 * Dropped from round 1: ls, cat, grep (not confined to the
 * workspace — agents read files with muse's own tools), find
 * (runs -exec/-delete), rosetta browse/--help/--version (browse
 * writes its DB). Dropped in round 3: centrs retrieve (C19 — a
 * fragment path dispatched POST /rest/system/reboot without
 * --yes; re-adding it waits for the upstream fix, consumed here
 * via the @tikoci/centrs pin). Housekeeping note: quickchr
 * list/doctor call refreshAllStatuses(), which rewrites stale
 * local machine state (clears dead PIDs/frozen markers) — local
 * bookkeeping, no device contact, acceptable in the read set.
 */
export const READ_COMMANDS: string[][] = [
	["quickchr", "list"],
	["quickchr", "doctor"],
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

/**
 * Our private muse config home (D44): the XDG_CONFIG_HOME our
 * workers spawn with. Pure. Derives from the data-home plumbing
 * (ServeOpts.dataHome) so tests isolate hermetically.
 */
export function privateConfigHome(dataHome?: string): string {
	return path.join(dataHomeDir(dataHome), "routeros-muse", "muse-config");
}

/**
 * In-process seeding mutex (D44). The seeding path is fully
 * synchronous, so run-to-completion already serializes it; this
 * guard makes that structural fact explicit and turns any future
 * re-entrancy into a loud error instead of an interleave.
 */
let seedHeld = false;
export function withSeedLock<T>(fn: () => T): T {
	if (seedHeld) throw new Error("preallow seeding re-entered");
	seedHeld = true;
	try {
		return fn();
	} finally {
		seedHeld = false;
	}
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
	/**
	 * The served workspace, or undefined in no-workspace mode (then
	 * only the network union is seeded and dead-root shell pruning
	 * still applies).
	 */
	workspaceRoot?: string;
	/**
	 * The network-rule union (normalized): every registered
	 * workspace's router.toml hosts when enabled, [] when disabled.
	 * Tagged network rules outside this set are pruned.
	 */
	hosts?: string[];
	/** False removes our tagged rules for this workspace instead. */
	enabled: boolean;
	/** Lock-acquire bound in ms (default SEED_LOCK_TIMEOUT_MS). */
	lockTimeoutMs?: number;
	/** Lock-stale age in ms (default SEED_LOCK_STALE_MS). */
	lockStaleMs?: number;
};

/**
 * Cross-process seed lock (round 3): the in-process mutex cannot
 * serialize two server processes, and the reread guard alone still
 * loses one side's rules when both rereads land before either
 * rename. So the whole read-merge-write loop runs under a lock
 * file next to the policy (approval-policy.json.lock): O_EXCL
 * create holding {pid, started}, bounded backoff while a live
 * process holds it, stale locks (dead pid or older than
 * SEED_LOCK_STALE_MS) broken, always released in a finally.
 */
export const SEED_LOCK_TIMEOUT_MS = 10_000;
export const SEED_LOCK_STALE_MS = 30_000;

/** Lock payload: the holding pid + the acquire timestamp. */
type SeedLock = { pid: number; started: number };

function lockFileFor(policyPath: string): string {
	return `${policyPath}.lock`;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

type LockState =
	| { status: "missing" }
	| { status: "live" }
	| { status: "stale"; raw: string };

/**
 * Classify the lock file: missing (released under us), live (a
 * running pid holds it and it is fresh), or stale (dead pid, or
 * older than staleMs). An unparseable lock leans live — only its
 * mtime age can break it — so a reader racing the holder's write
 * can never delete a live lock.
 */
function readLockState(lockFile: string, staleMs: number): LockState {
	let raw: string;
	try {
		raw = nodeFs.readFileSync(lockFile, "utf8");
	} catch {
		return { status: "missing" };
	}
	let pid = -1;
	let started = Number.NaN;
	try {
		const parsed = JSON.parse(raw) as Partial<SeedLock>;
		if (Number.isInteger(parsed.pid) && (parsed.pid as number) > 0) {
			pid = parsed.pid as number;
		}
		if (typeof parsed.started === "number") started = parsed.started;
	} catch {
		// Unparseable: fall through to the mtime age rule below.
	}
	if (!Number.isFinite(started)) {
		try {
			started = nodeFs.statSync(lockFile).mtimeMs;
		} catch {
			return { status: "missing" };
		}
	}
	const dead = pid > 0 ? !pidAlive(pid) : false;
	if (dead || Date.now() - started > staleMs) {
		return { status: "stale", raw };
	}
	return { status: "live" };
}

/**
 * Acquire the seed lock, or null after timeoutMs of bounded
 * exponential backoff (the caller warns and leaves the file
 * alone). Stale locks are broken, but only when the bytes are
 * unchanged since the read — never delete a lock a live process
 * just created. The returned thunk releases only what we still
 * hold; callers run it in a finally.
 */
function acquireSeedLock(
	policyPath: string,
	timeoutMs: number,
	staleMs: number,
): (() => void) | null {
	const lockFile = lockFileFor(policyPath);
	const content = JSON.stringify({ pid: process.pid, started: Date.now() });
	const deadline = Date.now() + timeoutMs;
	let attempt = 0;
	for (;;) {
		try {
			const fd = nodeFs.openSync(lockFile, "wx", 0o600);
			try {
				const buf = Buffer.from(content, "utf8");
				let off = 0;
				while (off < buf.length) {
					const n = nodeFs.writeSync(fd, buf, off, buf.length - off, null);
					if (n <= 0) throw new Error(`short write on ${lockFile}`);
					off += n;
				}
				nodeFs.fsyncSync(fd);
			} finally {
				nodeFs.closeSync(fd);
			}
			return () => {
				try {
					if (nodeFs.readFileSync(lockFile, "utf8") === content) {
						nodeFs.unlinkSync(lockFile);
					}
				} catch {
					// Gone or unreadable: nothing to release.
				}
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
		if (Date.now() >= deadline) return null;
		const state = readLockState(lockFile, staleMs);
		if (state.status === "stale") {
			try {
				if (nodeFs.readFileSync(lockFile, "utf8") === state.raw) {
					nodeFs.unlinkSync(lockFile);
				}
			} catch {
				// Lost the race or already gone: re-loop and retry.
			}
			continue;
		}
		if (state.status === "missing") continue; // Released under us: retry at once.
		attempt++;
		Bun.sleepSync(Math.min(200, 10 * 2 ** Math.min(attempt, 5)));
	}
}

export type EnsureResult = {
	changed: boolean;
	enabled: boolean;
	seededCommands: string[][];
	seededHosts: string[];
	warnings: string[];
};

/**
 * lstat the config-home root, the <configHome>/muse dir, and the
 * policy file. Returns the offending path when any is a symlink,
 * else null. Absent components are fine (not symlinks; creation
 * follows). The root is checked (round 3): a symlinked config
 * home would otherwise seed straight through into the target.
 */
function chainSymlink(file: string): string | null {
	const museDir = path.dirname(file);
	for (const p of [path.dirname(museDir), museDir, file]) {
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

/** The covered host of a tagged network rule, else null. */
function networkHost(entry: PolicyEntry): string | null {
	const rule = entry["rule"];
	if (!isRecord(rule)) return null;
	if (rule["kind"] !== "network") return null;
	return typeof rule["host"] === "string" ? (rule["host"] as string) : null;
}

/** A workspace root counts as live when it is still a directory. */
function rootAlive(root: string): boolean {
	try {
		return nodeFs.statSync(root).isDirectory();
	} catch {
		return false;
	}
}

/**
 * A network allow rule for one device host (D43): host-only, no
 * port, no protocol, no workspace scope. Grounded live (T101 probe
 * 82): this exact shape, seeded, let an https egress to
 * 127.0.0.1:3443 through with zero approval frames under :ask-me +
 * promptUnmatched, and boots clean (unknown fields would brick the
 * store — verified fatal on a probe). Muse's own persister writes
 * the narrower {host, port, protocol} variant; the host-only form
 * matches at least as broadly (every port, every protocol).
 *
 * Key order matches muse's writer (kind first, then host).
 */
export function networkRuleForHost(host: string): PolicyEntry {
	return { kind: "network", host };
}

function networkEntry(host: string): PolicyEntry {
	return {
		effect: "allow",
		durability: "local_persistent",
		rule: networkRuleForHost(host),
		reason: PREALLOW_TAG,
	};
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

/**
 * Network-rule ownership (D44): the union of router.toml device
 * hosts over workspace roots. readDevices is total (missing or
 * unparseable router.toml contributes nothing), so dead or
 * half-written roots simply drop out of the union.
 */
export function unionWorkspaceHosts(roots: string[]): string[] {
	const hosts: string[] = [];
	for (const root of roots) {
		for (const d of readDevices(root)) hosts.push(d.host ?? "");
	}
	return normalizeHosts(hosts);
}

/** Minimal muse-valid settings.json: schema_version only, nothing inherited. */
const PRIVATE_SETTINGS = '{"schema_version":1}\n';

export type PrivateHomeArgs = {
	/** Our private home (the workers' XDG_CONFIG_HOME). */
	privateHome: string;
	/** The user's real config home; defaults to the process one. */
	realConfigHome?: string;
	/**
	 * The data home anchoring the checked chain: when given,
	 * <dataHome>/routeros-muse is lstat'd too (round 3). Parents
	 * above it are never checked — a symlinked ~/.local is legit.
	 */
	dataHome?: string;
};

export type PrivateHomeResult = {
	changed: boolean;
	warnings: string[];
};

/**
 * Ensure the private muse config home (D44): <privateHome>/muse/
 * holding our own settings.json (minimal, muse-valid) plus an
 * auth.json SYMLINK to the real <configHome>/muse/auth.json,
 * re-ensured on every call (a regular file or stale link is
 * replaced). Dirs are created 0700; a symlink anywhere in the
 * private chain throws PolicySymlinkError without touching
 * anything. The real home is only ever read (link target), never
 * written: when the real auth.json is absent the link is skipped
 * and a "not signed in" warning is returned (the server surfaces
 * it through the boot/auth path), leaving any existing private
 * file alone. When both homes are the same path there is nothing
 * to link and the call is quiet.
 *
 * Auth content is never read and never logged — link targets only.
 */
/**
 * Tool config dirs linked from the private home to the owner's real
 * config home (D44): the trilogy's own (centrs.env lives here).
 */
export const LINKED_TOOL_CONFIG_DIRS = ["tikoci"] as const;

export function ensurePrivateHome(args: PrivateHomeArgs): PrivateHomeResult {
	return withSeedLock(() => {
		const museDir = path.join(args.privateHome, "muse");
		const settings = path.join(museDir, "settings.json");
		const policy = path.join(museDir, "approval-policy.json");
		// Round 3: the whole chain from <dataHome>/routeros-muse
		// down — routeros-muse, muse-config, muse, settings.json,
		// approval-policy.json. (auth.json and the tikoci link are
		// SUPPOSED to be symlinks, so they are never checked.)
		const chain: string[] = [args.privateHome, museDir, settings, policy];
		if (args.dataHome !== undefined) {
			chain.unshift(path.join(dataHomeDir(args.dataHome), "routeros-muse"));
		}
		for (const p of chain) {
			try {
				if (nodeFs.lstatSync(p).isSymbolicLink()) {
					throw new PolicySymlinkError(p);
				}
			} catch (err) {
				if (err instanceof PolicySymlinkError) throw err;
				// Absent: nothing to follow; creation follows.
			}
		}
		nodeFs.mkdirSync(museDir, { recursive: true });
		nodeFs.chmodSync(args.privateHome, 0o700);
		nodeFs.chmodSync(museDir, 0o700);
		let changed = false;
		const warnings: string[] = [];
		// settings.json: ours alone, written atomically (0600 temp +
		// rename), untouched when the bytes already match.
		let current: string | null = null;
		try {
			current = nodeFs.readFileSync(settings, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		if (current !== PRIVATE_SETTINGS) {
			const tmp = writeTempExclusive(settings, PRIVATE_SETTINGS);
			try {
				nodeFs.renameSync(tmp, settings);
			} catch (err) {
				try {
					nodeFs.unlinkSync(tmp);
				} catch {
					// Best effort.
				}
				throw err;
			}
			changed = true;
		} else if ((nodeFs.statSync(settings).mode & 0o777) !== 0o600) {
			// Round 3: byte-identical but wrong mode (0644) — the
			// temp+rename path above always lands 0600, so a wrong
			// mode here means something else touched it. Repair.
			nodeFs.chmodSync(settings, 0o600);
			changed = true;
		}
		// D44: muse's shell tools inherit XDG_CONFIG_HOME (muse 1.4.14
		// has no per-session env surface, and its tool shells do not
		// source BASH_ENV — both probed 2026-11-02). centrs resolves
		// centrs.env (e.g. CENTRS_SSH_KEY) under it, so the trilogy's
		// config dir is linked through, re-ensured like auth.json. A
		// real directory already there is left alone with a warning.
		for (const name of LINKED_TOOL_CONFIG_DIRS) {
			const real = path.join(configHomeDir(args.realConfigHome), name);
			const priv = path.join(args.privateHome, name);
			if (path.resolve(real) === path.resolve(priv)) continue;
			try {
				if (!nodeFs.statSync(real).isDirectory()) continue;
			} catch {
				continue; // No real config for this tool: nothing to link.
			}
			let st: nodeFs.Stats | null = null;
			try {
				st = nodeFs.lstatSync(priv);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
			if (st !== null && !st.isSymbolicLink()) {
				warnings.push(
					`${priv} is not a link to ${real}; agent-run tools will not see their own config there`,
				);
				continue;
			}
			if (st !== null && nodeFs.readlinkSync(priv) === real) continue;
			if (st !== null) nodeFs.unlinkSync(priv);
			nodeFs.symlinkSync(real, priv);
			changed = true;
		}
		// auth.json: a symlink to the real one, re-ensured.
		const realAuth = path.join(
			configHomeDir(args.realConfigHome),
			"muse",
			"auth.json",
		);
		const privAuth = path.join(museDir, "auth.json");
		if (path.resolve(realAuth) === path.resolve(privAuth)) {
			return { changed, warnings };
		}
		try {
			// stat, not lstat: a dangling real-auth symlink counts
			// as missing (round 3) — warn and leave any existing
			// private auth alone, never link a dead target.
			nodeFs.statSync(realAuth);
		} catch {
			warnings.push(
				`not signed in: ${realAuth} is missing (log in with muse, then retry)`,
			);
			return { changed, warnings };
		}
		let relink = true;
		try {
			if (
				nodeFs.lstatSync(privAuth).isSymbolicLink() &&
				nodeFs.readlinkSync(privAuth) === realAuth
			) {
				relink = false;
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		if (relink) {
			try {
				nodeFs.unlinkSync(privAuth);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
			nodeFs.symlinkSync(realAuth, privAuth);
			changed = true;
		}
		return { changed, warnings };
	});
}

const MAX_ATTEMPTS = 4; // Initial attempt plus up to 3 retries.

/** Canonical form for order-insensitive rule-set comparison. */
function canonicalize(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(canonicalize);
	if (isRecord(v)) {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k]);
		return out;
	}
	return v;
}

/** True when two rule lists hold the same entries in any order. */
function rulesEqual(a: unknown[], b: unknown[]): boolean {
	if (a.length !== b.length) return false;
	const sa = a.map((e) => JSON.stringify(canonicalize(e))).sort();
	const sb = b.map((e) => JSON.stringify(canonicalize(e))).sort();
	return sa.every((s, i) => s === sb[i]);
}

/**
 * Ensure this workspace's pre-seeded rules in approval-policy.json.
 *
 * Enabled: the current root holds exactly our shell set (stale
 * entries from older seed sets are replaced, never merged), our
 * tagged shell rules for roots that no longer exist are pruned,
 * our tagged rules for other live roots are kept, every foreign
 * entry is preserved in place, and the tagged network rules hold
 * exactly the host union (a host no live preallowed workspace
 * needs is pruned). Disabled: our tagged rules for this root are
 * removed, plus every tagged network rule (the union is empty);
 * dead-root pruning still applies. With no workspace root
 * (no-workspace mode) only the network union is seeded.
 *
 * No rewrite when nothing changed (order-insensitive compare
 * before writing). An unknown schema_version or unparseable file
 * skips with a warning and leaves the bytes alone — never rewrite
 * what we don't understand. A symlink in the chain throws
 * PolicySymlinkError. A file that changes under every attempt
 * gives up with a warning after MAX_ATTEMPTS, as does a lock held
 * past the acquire bound by another process.
 */
export function ensurePreallowReads(
	args: EnsureArgs,
	fs?: PreallowFs,
): EnsureResult {
	return withSeedLock(() => ensurePreallowReadsLocked(args, fs));
}

function ensurePreallowReadsLocked(
	args: EnsureArgs,
	fs?: PreallowFs,
): EnsureResult {
	const file = policyFile(args.configHome);
	const link = chainSymlink(file);
	if (link !== null) throw new PolicySymlinkError(link);
	nodeFs.mkdirSync(path.dirname(file), { recursive: true });
	const hosts = normalizeHosts(args.hosts ?? []);
	const wsRoot = args.workspaceRoot;
	const shell =
		args.enabled && wsRoot !== undefined
			? READ_COMMANDS.map((p) => shellEntry(p, wsRoot))
			: [];
	const desired: PolicyEntry[] = [
		...shell,
		...(args.enabled ? hosts.map((h) => networkEntry(h)) : []),
	];
	const seededCommands =
		args.enabled && wsRoot !== undefined
			? READ_COMMANDS.map((p) => [...p])
			: [];
	const base: EnsureResult = {
		changed: false,
		enabled: args.enabled,
		seededCommands,
		seededHosts: args.enabled ? [...hosts] : [],
		warnings: [],
	};
	const release = acquireSeedLock(
		file,
		args.lockTimeoutMs ?? SEED_LOCK_TIMEOUT_MS,
		args.lockStaleMs ?? SEED_LOCK_STALE_MS,
	);
	if (release === null) {
		return {
			...base,
			warnings: [
				`not seeding ${file}: another process holds the policy lock (leaving it alone)`,
			],
		};
	}
	try {
		return ensurePreallowReadsUnderLock(args, fs, file, desired, base);
	} finally {
		release();
	}
}

function ensurePreallowReadsUnderLock(
	args: EnsureArgs,
	fs: PreallowFs | undefined,
	file: string,
	desired: PolicyEntry[],
	base: EnsureResult,
): EnsureResult {
	const readFile: (file: string, encoding: "utf8") => string =
		fs?.readFileSync ?? ((f, e) => nodeFs.readFileSync(f, e));
	const renameSync = fs?.renameSync ?? nodeFs.renameSync;
	const unlinkSync = fs?.unlinkSync ?? nodeFs.unlinkSync;
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
			if (root !== null) {
				if (root === args.workspaceRoot) continue; // Replaced.
				if (rootAlive(root)) kept.push(entry); // Else pruned.
				continue;
			}
			const host = networkHost(entry);
			if (host !== null) {
				// Union ownership (D44): tagged network rules are
				// never kept — desired re-adds exactly the union
				// (empty when disabled), so anything outside it
				// belongs to no live preallowed workspace and is
				// pruned. Untagged network rules never reach this
				// branch: they are foreign and kept above.
				continue;
			}
			// Tagged but neither a shell nor a network rule (a newer
			// seed kind): keep, never destroy data from a newer writer.
			kept.push(entry);
		}
		const next = [...kept, ...desired];
		if (rulesEqual(next, rules)) {
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
		try {
			renameSync(tmp, file);
		} catch (err) {
			try {
				unlinkSync(tmp);
			} catch {
				// Best effort.
			}
			throw err;
		}
		return { ...base, changed: true };
	}
	return {
		...base,
		warnings: [
			`not seeding ${file}: changed under ${MAX_ATTEMPTS} attempts by a concurrent writer (leaving it alone)`,
		],
	};
}
