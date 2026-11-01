// pull.ts — capture one router into files: sanitized export, volatile-stripped
// JSON menus, sha256 manifest. Refuses on serial mismatch. Prototype (Track A).
//
//   pull --quickchr twin1 [--out DIR]
//   pull --host 192.168.74.1 --name bigdude [--out DIR]   (needs CENTRS_USERNAME/CENTRS_PASSWORD)
// Exit: 0 ok/partial, 2 refused, 1 error. Partial (some reads failed) keeps last good files.
import {
	existsSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Manifest } from "./sanitize";
import {
	checkSerial,
	redactExport,
	sha256Hex,
	stableExportHeader,
	stripVolatile,
} from "./sanitize";

const JSON_MENUS = [
	"/system/resource",
	"/ip/address",
	"/interface",
	"/system/package",
];

function usage(): never {
	console.error(
		"usage: pull --quickchr <name> | --host <addr> [--name <slot>] [--out DIR]",
	);
	process.exit(1);
}

const args = process.argv.slice(2);
let qchr = "",
	host = "",
	slot = "",
	outRoot = "out";
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--quickchr") qchr = args[++i] ?? "";
	else if (args[i] === "--host") host = args[++i] ?? "";
	else if (args[i] === "--name") slot = args[++i] ?? "";
	else if (args[i] === "--out") outRoot = args[++i] ?? "out";
	else usage();
}
if ((qchr && host) || (!qchr && !host)) usage();
if (!slot) slot = qchr || host;

async function run(cmd: string[]): Promise<{ ok: boolean; out: string }> {
	const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	// NOTE: centrs failure envelopes go to stderr with --json; success to stdout.
	return code === 0 ? { ok: true, out } : { ok: false, out: out + err };
}

async function toolVersion(cmd: string, vargs: string[]): Promise<string> {
	try {
		const r = await run([cmd, ...vargs]);
		return (r.out.split("\n")[0] ?? "").trim().slice(0, 40);
	} catch {
		return "unknown";
	}
}

const notes: string[] = [];
const files: { path: string; content: string }[] = [];
let partial = false;

// 1. Serial first (identity gate). Hardware: /system/routerboard serial-number.
// CHR has no routerboard; fall back to /system/license system-id (also in export header).
function baseArgs(): string[] {
	return qchr
		? ["centrs", "retrieve", "--quickchr", qchr]
		: ["centrs", "retrieve", "--host", host, "--via", "native-api"];
}
async function readField(menu: string, field: string): Promise<string> {
	const r = await run([
		...baseArgs(),
		menu,
		"--attributes",
		field,
		"--format",
		"json",
	]);
	try {
		const env = JSON.parse(r.out);
		// NOTE: single --attributes projects data to the scalar, not an object.
		if (r.ok && env.ok)
			return typeof env.data === "string" ? env.data : (env.data[field] ?? "");
	} catch {
		/* fall through */
	}
	return "";
}
let serial = await readField("/system/routerboard", "serial-number");
if (!serial) {
	const sysid = await readField("/system/license", "system-id");
	if (sysid) {
		serial = `system-id:${sysid}`;
		notes.push("no routerboard (CHR?); identity is license system-id");
	}
}
if (!serial) {
	console.error("pull: cannot read serial; refusing");
	process.exit(1);
}

const slotDir = join(outRoot, slot);
const latestManifest = join(slotDir, "latest", "manifest.json");
let prev: Manifest | null = null;
if (existsSync(latestManifest)) {
	try {
		prev = JSON.parse(readFileSync(latestManifest, "utf8"));
	} catch {
		/* corrupt prior: proceed, note it */ notes.push(
			"previous manifest unreadable; proceeding as first capture",
		);
	}
}
const refusal = checkSerial(prev, serial);
// Dir name matches the template capture boundary (`observations/*/pull-*/`
// is git-ignored); a bare timestamp would be committable.
const stamp = `pull-${new Date().toISOString().replace(/[:.]/g, "-")}`;
if (refusal) {
	const dir = join(slotDir, `${stamp}-refused`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "attempt.json"),
		JSON.stringify(
			{
				target: slot,
				serial,
				capturedAt: new Date().toISOString(),
				status: "refused",
				reason: refusal,
			},
			null,
			2,
		),
	);
	console.error(`pull: ${refusal}`);
	process.exit(2);
}

// 2. Export (twin path only; --host export needs the SSH-key path, still pending).
if (qchr) {
	const r = await run(["quickchr", "exec", qchr, "/export", "terse"]);
	if (r.ok && r.out.includes("by RouterOS")) {
		const clean = stableExportHeader(redactExport(r.out.replace(/\r/g, "")));
		files.push({ path: "export.rsc", content: clean });
	} else {
		partial = true;
		notes.push(`export failed: ${r.out.slice(0, 200)}`);
	}
} else {
	// D1: direct /export over native API runs as a read (no --yes). data.ret holds text.
	const r = await run([
		"centrs",
		"execute",
		"--host",
		host,
		"--via",
		"native-api",
		"--format",
		"json",
		"--",
		"/export terse",
	]);
	try {
		const env = JSON.parse(r.out);
		if (r.ok && env.ok && env.data?.ret?.includes("by RouterOS")) {
			files.push({
				path: "export.rsc",
				content: stableExportHeader(
					redactExport(env.data.ret.replace(/\r/g, "")),
				),
			});
		} else {
			partial = true;
			notes.push(
				`export failed: ${JSON.stringify(env.error ?? env).slice(0, 200)}`,
			);
		}
	} catch {
		partial = true;
		notes.push("export failed: unparseable output");
	}
}

// 3. JSON menus.
for (const menu of JSON_MENUS) {
	const r = await run([...baseArgs(), menu, "--format", "json"]);
	try {
		const env = JSON.parse(r.out);
		if (r.ok && env.ok) {
			const fname = `${menu.replace(/^\//, "").replace(/\//g, "-")}.json`;
			files.push({
				path: fname,
				content: `${JSON.stringify(stripVolatile(env.data), null, 2)}\n`,
			});
			continue;
		}
	} catch {
		/* fall through */
	}
	partial = true;
	notes.push(`${menu} failed: ${r.out.slice(0, 200)}`);
}

// 4. Write dir + manifest, flip latest.
const dir = join(slotDir, stamp);
mkdirSync(dir, { recursive: true });
const manifestFiles = files.map((f) => {
	writeFileSync(join(dir, f.path), f.content);
	return {
		path: f.path,
		sha256: sha256Hex(f.content),
		bytes: Buffer.byteLength(f.content),
	};
});
const manifest: Manifest = {
	target: slot,
	serial,
	capturedAt: new Date().toISOString(),
	tools: {
		centrs: await toolVersion("centrs", ["--help"]),
		quickchr: await toolVersion("quickchr", ["--version"]),
	},
	files: manifestFiles,
	status: partial ? "partial" : "ok",
	notes,
};
writeFileSync(
	join(dir, "manifest.json"),
	`${JSON.stringify(manifest, null, 2)}\n`,
);
try {
	unlinkSync(join(slotDir, "latest"));
} catch {
	/* first run */
}
symlinkSync(stamp, join(slotDir, "latest"));
console.log(
	JSON.stringify({
		status: manifest.status,
		dir,
		files: manifestFiles.length,
		notes,
	}),
);
