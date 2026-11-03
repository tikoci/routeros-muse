// Interactive prompts. Null when stdin is not a TTY (caller stops
// with a resume line instead of blocking forever).

import { spawnSync } from "node:child_process";
import * as readline from "node:readline/promises";

export function isTty(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function ask(question: string): Promise<string | null> {
	if (!isTty()) return null;
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		// Ctrl+D (EOF) rejects: a closed input is an abort, not a crash.
		const answer = await rl.question(`${question} `);
		return answer.trim();
	} catch {
		return null;
	} finally {
		rl.close();
	}
}

/** Yes/no; default no. */
export async function confirm(question: string): Promise<boolean | null> {
	const answer = await ask(`${question} [y/N]`);
	if (answer === null) return null;
	return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}

/**
 * Read the whole of stdin as a CDB password (--password-stdin):
 * one trailing newline stripped (the centrs --password-stdin
 * convention), null when empty or when stdin is a TTY. The caller
 * decides the abort message; nothing is printed here.
 */
export async function readStdinPassword(): Promise<string | null> {
	if (process.stdin.isTTY) return null;
	let data = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) data += chunk;
	const pw = data.replace(/\r?\n$/, "");
	return pw ? pw : null;
}

/**
 * Run stty on the terminal stdin (best-effort: exotic platforms
 * without stty keep raw-mode-only hiding).
 */
function sttyOnTty(...args: string[]): string | null {
	try {
		const r = spawnSync("stty", args, {
			stdio: ["inherit", "pipe", "ignore"],
		});
		if (r.error || r.status !== 0) return null;
		return (r.stdout as Buffer | string | null)?.toString() ?? "";
	} catch {
		return null;
	}
}

/**
 * Password prompt (T40 CLI unlock): raw-mode read with no echo, null
 * when stdin is not a TTY (the caller falls back to the
 * CENTRS_CDB_PASSWORD passthrough or stops). The prompt goes to
 * stderr so piped stdout stays clean; Ctrl-C aborts the process.
 * Raw mode alone leaves terminal echo on here, so echo is disabled
 * explicitly for the read and restored after.
 */
export async function askSecret(question: string): Promise<string | null> {
	if (!process.stdin.isTTY) return null;
	const stdin = process.stdin;
	process.stderr.write(`${question} `);
	const savedEcho = sttyOnTty("-g");
	sttyOnTty("-echo");
	stdin.setRawMode(true);
	stdin.resume();
	return new Promise((resolve) => {
		let pw = "";
		let settled = false;
		const done = (value: string | null, code?: number): void => {
			if (settled) return;
			settled = true;
			if (savedEcho) sttyOnTty(savedEcho.trim());
			else sttyOnTty("echo");
			stdin.setRawMode(false);
			stdin.pause();
			stdin.removeListener("data", onData);
			process.stderr.write("\n");
			if (code !== undefined) process.exit(code);
			resolve(value);
		};
		const onData = (chunk: Buffer): void => {
			for (const ch of chunk.toString("utf8")) {
				if (ch === "\r" || ch === "\n") done(pw);
				else if (ch === "\x03") done(null, 130);
				else if (ch === "\x7f" || ch === "\b") pw = pw.slice(0, -1);
				else if (ch >= " ") pw += ch;
			}
		};
		stdin.on("data", onData);
		stdin.once("end", () => done(null));
	});
}
