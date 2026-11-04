// Approval-policy pre-seeding (T101, D43/D44/D45; T55 ui tools):
// our designed read set as `shell_command_argv_prefix` allow rules
// in OUR OWN muse approval-policy.json (schema v2, inside this
// workspace's private config home), scoped to the workspace's
// absolute root, plus network allow rules for THIS workspace's
// router.toml device hosts only, plus `tool_action` allow rules
// for the four ui_* MCP tools (T55 plus T110, same toggle).
//
// Each workspace gets its own private home (D45):
// <dataHome>/routeros-muse/.muse-config/<workspace-id>/, holding
// its own approval-policy.json, settings.json, auth.json link and
// tikoci link. The leading dot marks the dir as managed, not for
// user editing (it is not a security measure). A moved workspace
// gets a new home — accepted by design; seeding recreates its
// rules from scratch. No-workspace mode gets the fixed
// .muse-config/_no-workspace/ home. The round-2/3 flat
// muse-config/muse/ layout is an orphan from development builds
// (it never shipped): left alone, never migrated or deleted.
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
// written fully, then rename. Per-workspace homes removed the
// cross-process seed lock (round 3, deleted in round 4 after a
// re-review confirmed four defects in it): the only concurrent
// writers left are our own live muse sessions persisting
// "Always allow" into the same file, so the flow is the
// in-process mutex plus read, merge, write-temp, re-read,
// rename-or-retry (initial attempt plus up to 3 retries), then an
// honest give-up that leaves the file alone.
import * as nodeCrypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SEED_TOOL_NAMES } from "../mcp/trilogy-tools";
import { readDevices } from "./fleet";
import { dataHomeDir } from "./registry";

/** Tag on every rule we write; the only rules we ever touch. */
export const PREALLOW_TAG = "routeros-muse:seed";

/** The only approval-policy schema we understand. */
export const POLICY_SCHEMA_VERSION = 2;

/**
 * Designed read set, one argv prefix per rule. D43 as amended
 * 2026-11-02 cut this to the three tikoci reads below; the developer
 * reversed the file half on 2026-11-03 (D54): an agent that needs
 * an approval for every `cat` or `ls` is not usable, and muse
 * approves each pipeline stage separately, so one shell call could
 * stack ten or more Once prompts. The file commands are read-only
 * viewers. Their path arguments are not confined to the workspace,
 * and the developer accepted that. Still excluded, because each one
 * can write: find (-exec/-delete), sed (-i), awk (system()), tee,
 * and rosetta browse (writes its DB). Bare tikoci binaries are
 * never seeded: [quickchr] would also free `quickchr remove`, and
 * centrs execute stays unlisted (--yes cannot be excluded). The
 * seeded retrieve rule trusts centrs's read/write split (reads
 * run, writes need --yes); the fragment-path bug is C19
 * (centrs#586). quickchr
 * list/doctor rewrite stale local machine state (dead PIDs/frozen
 * markers) with no device contact, which is acceptable here.
 */
export const READ_COMMANDS: string[][] = [
	["centrs", "retrieve"],
	["centrs", "devices", "list"],
	["centrs", "explain"],
	["quickchr", "list"],
	["quickchr", "doctor"],
	["ls"],
	["cat"],
	["head"],
	["tail"],
	["wc"],
	["grep"],
	["file"],
	["stat"],
	["pwd"],
	["echo"],
	["which"],
];

/**
 * Explicit opt beats XDG_CONFIG_HOME beats ~/.config. An empty
 * XDG_CONFIG_HOME falls back like an unset one (the muse launcher
 * tests -n, so we match it).
 */
export function configHomeDir(explicit?: string): string {
	if (explicit !== undefined) return explicit;
	return process.env["XDG_CONFIG_HOME"] || path.join(os.homedir(), ".config");
}

/** The muse approval-policy file under a config home. Pure. */
export function policyFile(configHome?: string): string {
	return path.join(configHomeDir(configHome), "muse", "approval-policy.json");
}

/**
 * The real muse auth file both the agent check and the
 * private-home linker resolve: `$XDG_CONFIG_HOME/muse/auth.json`,
 * else `~/.config/muse/auth.json` (the muse launcher's own order,
 * verified in its script; the binary reads auth only from there).
 * win32 keeps %APPDATA% — UNVERIFIED, no Windows probe; kept from
 * the pre-D45 agent check rather than re-derived.
 */
export function museAuthFile(explicitConfigHome?: string): string {
	if (process.platform === "win32") {
		const base =
			process.env["APPDATA"] ?? path.join(os.homedir(), "AppData", "Roaming");
		return path.join(base, "muse", "auth.json");
	}
	return path.join(configHomeDir(explicitConfigHome), "muse", "auth.json");
}

/**
 * Managed dir holding every per-workspace private home (D45). The
 * leading dot marks it as managed, not for user editing — it is
 * not a security measure.
 */
export const MUSE_CONFIG_DIR = ".muse-config";

/** Fixed home id for no-workspace mode (D23). */
export const NO_WORKSPACE_ID = "_no-workspace";

/**
 * Root holding every per-workspace private home:
 * <dataHome>/routeros-muse/.muse-config. Pure.
 */
export function privateConfigRoot(dataHome?: string): string {
	return path.join(dataHomeDir(dataHome), "routeros-muse", MUSE_CONFIG_DIR);
}

/**
 * Stable, filesystem-safe id for a workspace root (D45):
 * <sanitized-basename>-<hash12>, where the hash covers the
 * canonical absolute root (realpath; path.resolve when the root
 * cannot be resolved). Readable first, unique always. A moved
 * workspace gets a new home — accepted by design; seeding
 * recreates its rules. Pure.
 */
/** Max readable-basename length in a workspace id (D45). */
export const WORKSPACE_ID_BASE_MAX = 48;

export function workspaceConfigId(workspaceRoot: string): string {
	let canonical: string;
	try {
		canonical = nodeFs.realpathSync(workspaceRoot);
	} catch {
		canonical = path.resolve(workspaceRoot);
	}
	// Bounded so <base>-<hash12> stays far below NAME_MAX (255) for
	// any valid workspace name (round-4 review: a 243-char basename
	// overflowed). The hash carries uniqueness; base is for humans.
	const base =
		path
			.basename(canonical)
			.replace(/[^A-Za-z0-9._-]+/g, "-")
			.slice(0, WORKSPACE_ID_BASE_MAX) || "ws";
	const hash = nodeCrypto
		.createHash("sha256")
		.update(canonical)
		.digest("hex")
		.slice(0, 12);
	return `${base}-${hash}`;
}

/**
 * This workspace's private muse config home (D45): the
 * XDG_CONFIG_HOME our workers spawn with. Pure. Derives from the
 * data-home plumbing (ServeOpts.dataHome) so tests isolate
 * hermetically. An undefined root is no-workspace mode and gets
 * the fixed _no-workspace home.
 */
export function privateConfigHome(
	dataHome?: string,
	workspaceRoot?: string,
): string {
	return path.join(
		privateConfigRoot(dataHome),
		workspaceRoot === undefined
			? NO_WORKSPACE_ID
			: workspaceConfigId(workspaceRoot),
	);
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
	 * no shell rules are seeded and any tagged shell rule is pruned).
	 */
	workspaceRoot?: string;
	/**
	 * This workspace's router.toml hosts (normalized): seeded when
	 * enabled, [] when disabled. Tagged network rules outside this
	 * set are pruned. There is no cross-workspace union (D45):
	 * each workspace seeds only its own hosts into its own home.
	 */
	hosts?: string[];
	/** False removes our tagged rules for this workspace instead. */
	enabled: boolean;
	/**
	 * The tool_action seed set (T105): narrowed by the caller to
	 * servers whose bundle entries resolved, so no rules are seeded
	 * for tools no session has. Defaults to the full seed set.
	 */
	seedTools?: string[];
};

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read a small regular file without following a symlink and
 * without blocking on a FIFO/device: O_NOFOLLOW | O_NONBLOCK, then
 * fstat must say regular. Null on anything else or any error.
 */
function readRegularNoFollow(file: string): string | null {
	const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = nodeFs.constants;
	let fd: number;
	try {
		fd = nodeFs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
	} catch {
		return null;
	}
	try {
		const st = nodeFs.fstatSync(fd);
		if (!st.isFile() || st.size > 64) return null;
		const buf = Buffer.alloc(st.size);
		const n = nodeFs.readSync(fd, buf, 0, st.size, 0);
		return buf.subarray(0, n).toString("utf8");
	} catch {
		return null;
	} finally {
		nodeFs.closeSync(fd);
	}
}

/**
 * Same-workspace detection (D45): a pid file in the workspace's
 * private home. WARN ONLY — correctness never depends on it: no
 * blocking, a stale pid file is silently ignored, and a symlink
 * is never followed (neither read nor replaced). Total: any fs
 * error means no warning. Our own pid is recorded (best effort)
 * so the next server sees us.
 */
export function checkServerPid(privateHome: string): {
	warning: string | null;
} {
	const pidFile = path.join(privateHome, "server.pid");
	let warning: string | null = null;
	let homeLinked = false;
	try {
		homeLinked = nodeFs.lstatSync(privateHome).isSymbolicLink();
	} catch {
		// Absent: nothing to follow; creation follows below.
	}
	try {
		if (!homeLinked) {
			const text = readRegularNoFollow(pidFile);
			if (text !== null) {
				const pid = Number(text.trim());
				if (
					Number.isInteger(pid) &&
					pid > 0 &&
					pid !== process.pid &&
					pidAlive(pid)
				) {
					warning =
						`another server (pid ${pid}) may already be serving this ` +
						`workspace; both share the private home ${privateHome}`;
				}
			}
		}
	} catch {
		// Missing, unreadable, or unparseable: no warning.
	}
	// Our own pid is recorded even when warning (so the other
	// side warns back on its next check), but never through a
	// symlink — a linked pid file is left entirely alone.
	let linked = false;
	try {
		linked = nodeFs.lstatSync(pidFile).isSymbolicLink();
	} catch {
		// Absent: fall through and create it.
	}
	if (!linked && !homeLinked) {
		try {
			nodeFs.mkdirSync(privateHome, { recursive: true });
			// Temp + rename, never an open of the existing entry: a
			// FIFO (or any special file) at server.pid is replaced,
			// not written into (round-4 review: writeFileSync on a
			// FIFO blocked boot waiting for a reader).
			const tmp = writeTempExclusive(pidFile, `${process.pid}\n`);
			try {
				nodeFs.renameSync(tmp, pidFile);
			} catch (err) {
				try {
					nodeFs.unlinkSync(tmp);
				} catch {
					// Best effort.
				}
				throw err;
			}
		} catch {
			// Warn-only state: never fail the caller.
		}
	}
	return { warning };
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

/**
 * A ui_* allow rule (T55/D41, plus T110 ui_add_device): kind tool_action naming the
 * namespaced tool, with NO workspace scope (global to the home —
 * grounded P7). The home itself is per-workspace (D45), so the
 * rules stay workspace-scoped through it. Key order matches
 * muse's writer (kind first, then tool_name).
 */
export function toolRuleForMcp(toolName: string): PolicyEntry {
	return { kind: "tool_action", tool_name: toolName };
}

/** The covered tool of a tool_action rule, else null. */
function toolActionName(entry: PolicyEntry): string | null {
	const rule = entry["rule"];
	if (!isRecord(rule)) return null;
	if (rule["kind"] !== "tool_action") return null;
	return typeof rule["tool_name"] === "string"
		? (rule["tool_name"] as string)
		: null;
}

function toolEntry(toolName: string): PolicyEntry {
	// Key order matches muse's own writer (P7 capture).
	return {
		effect: "allow",
		durability: "local_persistent",
		rule: toolRuleForMcp(toolName),
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
 * Network-rule ownership (D45): this workspace's router.toml
 * device hosts. readDevices is total (a missing or unparseable
 * router.toml contributes nothing), so a dead or half-written
 * root simply seeds no hosts. Each workspace seeds only its own
 * hosts into its own home — there is no cross-workspace union.
 */
export function workspaceHosts(workspaceRoot: string): string[] {
	const hosts: string[] = [];
	for (const d of readDevices(workspaceRoot)) hosts.push(d.host ?? "");
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
		// The whole chain from <dataHome>/routeros-muse down —
		// routeros-muse, .muse-config, <workspace-id> (the
		// private home itself), muse, settings.json,
		// approval-policy.json. (auth.json and the tikoci link are
		// SUPPOSED to be symlinks, so they are never checked.)
		// Parents above routeros-muse are never checked — a
		// symlinked ~/.local is legit.
		const chain: string[] = [args.privateHome, museDir, settings, policy];
		if (args.dataHome !== undefined) {
			const appDir = path.join(dataHomeDir(args.dataHome), "routeros-muse");
			chain.unshift(appDir, path.join(appDir, MUSE_CONFIG_DIR));
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
		// Resolved through the shared helper so the agent check
		// and the linker never disagree on the store.
		const realAuth = museAuthFile(args.realConfigHome);
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
 * The file is this workspace's own (D45 per-workspace home), so
 * every tagged rule in it is ours to replace. Enabled: the tagged
 * shell rules are exactly our set for the current root (rules
 * written under any other spelling of the root, or by older seed
 * sets, are replaced), every foreign entry is preserved in place,
 * and the tagged network rules hold exactly this workspace's hosts.
 * Disabled: every tagged shell and network rule is removed. With
 * no workspace root (no-workspace mode) no shell rules are seeded.
 *
 * No rewrite when nothing changed (order-insensitive compare
 * before writing). An unknown schema_version or unparseable file
 * skips with a warning and leaves the bytes alone — never rewrite
 * what we don't understand. A symlink in the chain throws
 * PolicySymlinkError. A file that changes under every attempt
 * gives up with a warning after MAX_ATTEMPTS.
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
		// The ui_* tools ride the same toggle (T55): seeded whenever
		// preallow is on, in workspace and no-workspace homes alike.
		// T105/T112: the read-only rosetta MCP tools ride it too
		// (tagged tool_action rules, global like the ui ones — the
		// home itself is per-workspace, D45). No centrs_* rule is
		// seeded any more (T112: agents use the centrs CLI this
		// phase); stale tagged centrs_* rules prune on reseed like
		// any retired name. Mixed/write tools are never seeded:
		// per-op scoping is impossible (P7).
		...(args.enabled
			? (args.seedTools ?? SEED_TOOL_NAMES).map((t) => toolEntry(t))
			: []),
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
	return ensurePreallowReadsWrite(fs, file, desired, base);
}

function ensurePreallowReadsWrite(
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
			if (shellRoot(entry) !== null) {
				// Per-workspace home (D45): every tagged shell rule
				// here belongs to this workspace, whatever spelling
				// of its root wrote it (round-4 review: a symlinked
				// spelling kept the real path's grants after the
				// toggle went off). desired re-adds exactly the
				// current root's set (empty when disabled).
				continue;
			}
			const host = networkHost(entry);
			if (host !== null) {
				// Per-workspace ownership (D45): tagged network
				// rules are never kept — desired re-adds exactly
				// this workspace's hosts (empty when disabled),
				// so anything outside it is pruned. Untagged
				// network rules never reach this branch: they are
				// foreign and kept above.
				continue;
			}
			if (toolActionName(entry) !== null) {
				// Per-workspace ownership (D45): tagged tool_action
				// rules are never kept — desired re-adds exactly the
				// current seed set (empty when disabled), so a stale
				// tagged name is pruned. Untagged tool rules (the
				// owner's own Always-allow choices, reason null) never
				// reach this branch: they are foreign and kept above.
				continue;
			}
			// Tagged but neither a shell, network, nor tool rule (a
			// newer seed kind): keep, never destroy data from a newer
			// writer.
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
