// Step 6: handoff read. List operations/*-handoff.md + inbox items,
// newest first, with owner/status where the shape carries them.

import * as nodeFs from "node:fs";
import * as path from "node:path";

export type HandoffItem = {
	rel: string;
	mtimeMs: number;
	kind: "handoff" | "inbox";
	title: string;
	owner: string | null;
	status: string | null;
	dod: boolean;
};

function firstMatch(text: string, re: RegExp): string | null {
	for (const line of text.split("\n").slice(0, 40)) {
		const m = line.match(re);
		if (m?.[1]?.trim()) return m[1].trim().slice(0, 80);
	}
	return null;
}

function describeFile(
	full: string,
	rel: string,
	kind: HandoffItem["kind"],
): HandoffItem {
	let text = "";
	try {
		text = nodeFs.readFileSync(full, "utf8");
	} catch {
		text = "";
	}
	const title =
		firstMatch(text, /^#\s+(.+)$/m) ??
		firstMatch(text, /^(?:title)\s*[:：]\s*(.+)$/im) ??
		path.basename(rel);
	const owner = firstMatch(text, /^owner\s*[:：]\s*(.+)$/im);
	const status = firstMatch(text, /^status\s*[:：]\s*(.+)$/im);
	const dod = /definition of done/i.test(text);
	let mtimeMs = 0;
	try {
		mtimeMs = nodeFs.statSync(full).mtimeMs;
	} catch {
		mtimeMs = 0;
	}
	return { rel, mtimeMs, kind, title, owner, status, dod };
}

function listDir(dir: string, glob: (name: string) => boolean): string[] {
	try {
		return [
			...new Bun.Glob("*").scanSync({ cwd: dir, onlyFiles: true }),
		].filter(glob);
	} catch {
		return [];
	}
}

/** Newest first. Inbox skips READMEs and dotfiles (unshaped, not work). */
export function listHandoffs(wsDir: string): HandoffItem[] {
	const items: HandoffItem[] = [];
	const opsDir = path.join(wsDir, "operations");
	for (const name of listDir(opsDir, (n) => n.endsWith("-handoff.md"))) {
		items.push(
			describeFile(path.join(opsDir, name), `operations/${name}`, "handoff"),
		);
	}
	const inboxDir = path.join(wsDir, "inbox");
	for (const name of listDir(
		inboxDir,
		(n) => !n.startsWith(".") && n.toLowerCase() !== "readme.md",
	)) {
		items.push(
			describeFile(path.join(inboxDir, name), `inbox/${name}`, "inbox"),
		);
	}
	items.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return items;
}

export function printHandoffs(items: HandoffItem[]): void {
	if (items.length === 0) {
		console.log(
			"  no pending handoffs (operations/*-handoff.md, inbox/ empty)",
		);
		return;
	}
	for (const item of items) {
		const when = new Date(item.mtimeMs)
			.toISOString()
			.slice(0, 16)
			.replace("T", " ");
		const tag = item.kind === "handoff" ? "handoff" : "inbox";
		console.log(`  [${tag}] ${item.rel} — ${item.title} (${when})`);
		if (item.owner ?? item.status) {
			console.log(
				`          owner: ${item.owner ?? "?"}; status: ${item.status ?? "?"}; DoD: ${item.dod ? "present" : "MISSING"}`,
			);
		}
	}
}
