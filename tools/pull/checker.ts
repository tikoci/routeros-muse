// checker.ts — verify pull captures on disk: manifest schema, sha256 per file,
// latest symlink, total bytes. No router contact; captures on disk are input.
//
//   bun checker.ts --device <name> [--out DIR]
//   bun checker.ts --all [--out DIR]
// Exit: 0 clean, 1 problems. Prints one JSON line per slot.
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import type { Manifest } from "./sanitize";

export interface SlotReport {
	slot: string;
	ok: boolean;
	dir: string;
	totalBytes: number;
	files: number;
	problems: string[];
}

const HEX64 = /^[0-9a-f]{64}$/;

// Schema check on a parsed manifest value. Returns problem strings.
export function verifyManifestSchema(manifest: unknown): string[] {
	const problems: string[] = [];
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
		return ["manifest is not an object"];
	}
	const m = manifest as Record<string, unknown>;
	if (typeof m["target"] !== "string" || !m["target"])
		problems.push("manifest.target missing or empty");
	if (typeof m["serial"] !== "string" || !m["serial"])
		problems.push("manifest.serial missing or empty");
	if (
		typeof m["capturedAt"] !== "string" ||
		Number.isNaN(Date.parse(m["capturedAt"]))
	) {
		problems.push("manifest.capturedAt missing or not a date");
	}
	const tools = m["tools"] as Record<string, unknown> | undefined;
	if (
		!tools ||
		typeof tools["centrs"] !== "string" ||
		typeof tools["quickchr"] !== "string"
	) {
		problems.push("manifest.tools.centrs/quickchr missing");
	}
	if (!Array.isArray(m["files"])) {
		problems.push("manifest.files missing or not an array");
	} else {
		for (const f of m["files"]) {
			const e = f as Record<string, unknown>;
			if (typeof e?.["path"] !== "string" || !e["path"]) {
				problems.push("file entry with missing path");
				continue;
			}
			if (typeof e["sha256"] !== "string" || !HEX64.test(e["sha256"]))
				problems.push(`${e["path"]}: bad sha256`);
			if (typeof e["bytes"] !== "number" || e["bytes"] < 0)
				problems.push(`${e["path"]}: bad bytes`);
		}
	}
	if (
		m["status"] !== "ok" &&
		m["status"] !== "partial" &&
		m["status"] !== "refused"
	) {
		problems.push("manifest.status not ok/partial/refused");
	}
	if (
		!Array.isArray(m["notes"]) ||
		!(m["notes"] as unknown[]).every((n) => typeof n === "string")
	) {
		problems.push("manifest.notes missing or not string[]");
	}
	return problems;
}

// Hash + size check for one capture dir against its manifest file list.
export function verifyFiles(
	dir: string,
	files: Manifest["files"],
): { problems: string[]; totalBytes: number } {
	const problems: string[] = [];
	let totalBytes = 0;
	for (const f of files) {
		const p = join(dir, f.path);
		if (!existsSync(p)) {
			problems.push(`${f.path}: missing`);
			continue;
		}
		const content = readFileSync(p);
		totalBytes += content.length;
		if (content.length !== f.bytes)
			problems.push(
				`${f.path}: bytes ${content.length} != manifest ${f.bytes}`,
			);
		if (sha256HexBytes(content) !== f.sha256)
			problems.push(`${f.path}: sha256 mismatch`);
	}
	return { problems, totalBytes };
}

function sha256HexBytes(buf: Buffer): string {
	const h = new Bun.CryptoHasher("sha256");
	h.update(buf);
	return h.digest("hex");
}

// Full check of one slot dir (out/<slot>). Pure apart from fs reads.
export function verifySlot(slotDir: string, slot: string): SlotReport {
	const problems: string[] = [];
	if (!existsSync(slotDir)) {
		return {
			slot,
			ok: false,
			dir: slotDir,
			totalBytes: 0,
			files: 0,
			problems: [`slot dir missing: ${slotDir}`],
		};
	}
	const latestLink = join(slotDir, "latest");
	const dir = latestLink;
	try {
		const st = lstatSync(latestLink);
		if (!st.isSymbolicLink()) problems.push("latest is not a symlink");
		else if (!existsSync(latestLink) || !statSync(latestLink).isDirectory()) {
			problems.push("latest symlink is dangling");
		}
	} catch {
		problems.push("latest symlink missing");
	}
	const manifestPath = join(dir, "manifest.json");
	let manifest: Manifest | null = null;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		problems.push("manifest.json missing or unreadable");
	}
	let totalBytes = 0;
	let fileCount = 0;
	if (manifest) {
		problems.push(...verifyManifestSchema(manifest));
		if (Array.isArray((manifest as Manifest).files)) {
			fileCount = (manifest as Manifest).files.length;
			const r = verifyFiles(dir, (manifest as Manifest).files);
			problems.push(...r.problems);
			totalBytes = r.totalBytes;
		}
	}
	return {
		slot,
		ok: problems.length === 0,
		dir,
		totalBytes,
		files: fileCount,
		problems,
	};
}

function usage(): never {
	console.error(
		"usage: bun checker.ts --device <name> [--out DIR] | --all [--out DIR]",
	);
	process.exit(1);
}

// Skip CLI when imported by tests.
if (import.meta.main) {
	const args = process.argv.slice(2);
	let slot = "",
		outRoot = "out",
		all = false;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--device") slot = args[++i] ?? "";
		else if (args[i] === "--out") outRoot = args[++i] ?? "out";
		else if (args[i] === "--all") all = true;
		else usage();
	}
	if ((all && slot) || (!all && !slot)) usage();

	const slots = all
		? readdirSync(outRoot, { withFileTypes: true })
				.filter((d) => d.isDirectory() || d.isSymbolicLink())
				.map((d) => d.name)
				.sort()
		: [slot];

	let failed = false;
	for (const s of slots) {
		const report = verifySlot(join(outRoot, s), s);
		if (!report.ok) failed = true;
		console.log(JSON.stringify(report));
	}
	process.exit(failed ? 1 : 0);
}
