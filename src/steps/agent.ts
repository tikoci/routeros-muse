// Step 3: agent check. Is `muse` present? If missing, attempt the
// official user-level install (echoed, under the one-yes), else
// print-and-stop with a resume command. If present but
// unauthenticated, walk the owner through `muse`'s own auth flow;
// auth lives in muse's store, never here. reportAgent is the
// print-only twin for doctor: same facts, never installs.

import * as os from "node:os";
import * as path from "node:path";
import { type Ctx, ensureConsent, resumeLine } from "../ctx";
import { have, runShell } from "../lib/run";
import { Stop } from "../lib/stop";

export const MUSE_INSTALL_SH =
	"curl -fsSL https://dev.meta.ai/install.sh | bash";
export const MUSE_INSTALL_PS1 = "irm https://dev.meta.ai/install.ps1 | iex";

/** The official user-level installer for this OS. */
export function museInstallLine(): string {
	return process.platform === "win32" ? MUSE_INSTALL_PS1 : MUSE_INSTALL_SH;
}

export function museAuthFile(): string {
	if (process.platform === "win32") {
		const base =
			process.env["APPDATA"] ?? path.join(os.homedir(), "AppData", "Roaming");
		return path.join(base, "muse", "auth.json");
	}
	return path.join(os.homedir(), ".config", "muse", "auth.json");
}

/**
 * Auth heuristic (prototype-grade): META_API_KEY wins (muse's own
 * rule), else a non-empty auth.json in muse's store. There is no
 * non-interactive whoami; a stale file can lie, so the launch line
 * is the final word.
 */
export async function museAuthSource(): Promise<"env" | "file" | null> {
	if (process.env["META_API_KEY"]?.trim()) return "env";
	const file = Bun.file(museAuthFile());
	if (await file.exists()) {
		const text = (await file.text()).trim();
		if (text.length > 2) return "file";
	}
	return null;
}

export function authWalkthrough(label: string, cmd = "code"): string[] {
	const resume = ["bunx", "@tikoci/routeros-muse", cmd, label].join(" ");
	return [
		"muse is installed but shows no login (no META_API_KEY, no auth in muse's store).",
		"Sign in with muse's own flow (nothing is collected or stored here):",
		"  1. Run: muse login",
		"  2. Approve the code in your browser.",
		"Then resume with:",
		`  ${resume}`,
	];
}

export function authSummary(auth: "env" | "file"): string {
	return `muse auth: assumed signed in (via ${auth === "env" ? "META_API_KEY" : "muse's own store"}; the launch is the final word)`;
}

export async function checkAgent(ctx: Ctx): Promise<void> {
	if (!have("muse")) {
		console.log("  muse: MISSING");
		if (process.platform === "win32") {
			throw new Stop([
				"muse is not installed. Install it in PowerShell, then resume:",
				`  ${museInstallLine()}`,
				`  ${resumeLine(ctx)}`,
			]);
		}
		console.log(`  official user-level installer: ${museInstallLine()}`);
		if (!(await ensureConsent(ctx, "muse install"))) {
			throw new Stop([
				"Declined. Install muse by hand, then resume:",
				`  ${museInstallLine()}`,
				`  ${resumeLine(ctx)}`,
			]);
		}
		console.log(`  $ ${museInstallLine()}`);
		const r = await runShell(museInstallLine(), { timeoutMs: 300_000 });
		if (!have("muse")) {
			throw new Stop([
				`muse installer ran (exit ${r.exit}) but muse is still not on PATH.`,
				"Install it by hand, make sure it is on PATH, then resume:",
				`  ${museInstallLine()}`,
				`  ${resumeLine(ctx)}`,
			]);
		}
		console.log("  muse installed.");
	} else {
		console.log("  muse: present");
	}

	const auth = await museAuthSource();
	if (auth === null) {
		throw new Stop(authWalkthrough(ctx.workspaceLabel));
	}
	console.log(`  ${authSummary(auth)}`);
}

/**
 * Print-only agent facts for doctor. Never installs, never throws:
 * missing items come back in the report and fail the run at the end.
 */
export async function reportAgent(label: string): Promise<{
	missing: string[];
}> {
	const missing: string[] = [];
	if (!have("muse")) {
		console.log("  muse: MISSING");
		console.log(`  install: ${museInstallLine()}`);
		missing.push("muse (not installed)");
	} else {
		console.log("  muse: present");
	}
	const auth = await museAuthSource();
	if (auth === null) {
		for (const line of authWalkthrough(label, "doctor")) {
			console.log(`  ${line}`);
		}
		missing.push("muse auth (not signed in)");
	} else {
		console.log(`  ${authSummary(auth)}`);
	}
	return { missing };
}
