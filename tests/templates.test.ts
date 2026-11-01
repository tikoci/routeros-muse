// Template tests (T93): manifests, {{name}} substitution, [template]
// provenance, both templates scaffolding + validating, init
// no-clobber + rollback, and the picker template routes. Hermetic:
// temp dirs (all cleaned in afterAll), stub centrs, no live turns.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	copyTemplateFiles,
	listTemplateFiles,
	listTemplates,
	readTemplateMeta,
	templateDir,
	templatesRoot,
} from "../src/lib/templates";
import { toolEnv } from "../src/lib/tools";
import { scaffoldIntoDir, scaffoldWorkspace } from "../src/lib/workspace";
import { startServer } from "../src/serve/server";
import { readAndValidate } from "../src/steps/workspace";

const POSIX = process.platform !== "win32";
const tposix = POSIX ? test : test.skip;

const tmpdirs: string[] = [];
afterAll(() => {
	for (const d of tmpdirs) {
		nodeFs.rmSync(d, { recursive: true, force: true });
	}
});

function mktmp(prefix: string): string {
	const d = nodeFs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpdirs.push(d);
	return d;
}

function writeShim(dir: string, name: string, body: string): void {
	const file = path.join(dir, name);
	nodeFs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
	nodeFs.chmodSync(file, 0o755);
}

/** Stub bin: centrs init touches the CDB; list reports cdb/not-found. */
function stubCentrsBin(): string {
	const dir = mktmp("t93-tpl-bin-");
	writeShim(
		dir,
		"centrs",
		`if [ "$1" = "devices" ] && [ "$2" = "init" ]; then\n` +
			`  while [ $# -gt 0 ]; do if [ "$1" = "--cdb-file" ]; then : > "$2"; exit 0; fi; shift; done\n` +
			`  exit 1\nfi\n` +
			`if [ "$1" = "devices" ] && [ "$2" = "list" ]; then\n` +
			`  echo '{"ok":false,"error":{"code":"cdb/not-found"}}'\n` +
			`  exit 0\nfi\nexit 1`,
	);
	return dir;
}

function failingCentrsBin(): string {
	const dir = mktmp("t93-tpl-failbin-");
	writeShim(dir, "centrs", "exit 1");
	return dir;
}

const ROOT = templatesRoot();
if (!ROOT) throw new Error("templates root missing under test");

describe("template discovery", () => {
	test("lists minimal and network with versions", () => {
		const list = listTemplates(ROOT);
		expect(list.map((t) => t.name)).toEqual(["minimal", "network"]);
		for (const t of list) {
			expect(t.version).toBe("0.1.0");
			expect(t.description.length).toBeGreaterThan(0);
		}
	});

	test("missing root lists nothing", () => {
		expect(listTemplates(path.join(mktmp("t93-tpl-noroot-"), "nope"))).toEqual(
			[],
		);
		expect(listTemplates(null)).toEqual([]);
	});

	test("manifest reads, garbage does not", () => {
		expect(readTemplateMeta(path.join(ROOT, "minimal"))).toEqual({
			name: "minimal",
			description: expect.any(String),
			version: "0.1.0",
		});
		expect(readTemplateMeta(mktmp("t93-tpl-nometa-"))).toBeNull();
	});

	test("templateDir refuses unknown and escaping names", () => {
		expect(templateDir(ROOT, "minimal")).toBe(path.join(ROOT, "minimal"));
		expect(templateDir(ROOT, "nope")).toBeNull();
		expect(templateDir(ROOT, "../lib")).toBeNull();
		expect(templateDir(null, "minimal")).toBeNull();
	});

	test("minimal file list excludes the manifest", () => {
		expect(listTemplateFiles(path.join(ROOT, "minimal"))).toEqual([
			".gitignore",
			"AGENTS.md",
			"router.toml",
			"workspace.toml",
		]);
	});

	test("network file list excludes the manifest", () => {
		const files = listTemplateFiles(path.join(ROOT, "network"));
		expect(files).toContain("workspace.toml");
		expect(files).toContain("START-HERE.md");
		expect(files).not.toContain("template.toml");
	});
});

describe("package root under a spaced path", () => {
	tposix("an install path with spaces still finds the package", async () => {
		// sol review of T93: URL.pathname kept %20, so a package under
		// "package space/" resolved no root and listed no templates.
		const pkg = path.join(mktmp("t93-tpl-space-"), "package space");
		nodeFs.mkdirSync(path.join(pkg, "src", "lib"), { recursive: true });
		nodeFs.copyFileSync(
			path.join(import.meta.dir, "..", "package.json"),
			path.join(pkg, "package.json"),
		);
		for (const f of ["tools.ts", "run.ts"]) {
			nodeFs.copyFileSync(
				path.join(import.meta.dir, "..", "src", "lib", f),
				path.join(pkg, "src", "lib", f),
			);
		}
		const mod = (await import(path.join(pkg, "src", "lib", "tools.ts"))) as {
			packageRoot: () => string | null;
		};
		expect(mod.packageRoot()).toBe(pkg);
	});
});

describe("copy + provenance", () => {
	test("{{name}} substitutes in toml/md only; manifest stays out", () => {
		const src = mktmp("t93-tpl-src-");
		nodeFs.writeFileSync(path.join(src, "template.toml"), 'name = "x"\n');
		nodeFs.writeFileSync(path.join(src, "a.toml"), 'n = "{{name}}"\n');
		nodeFs.writeFileSync(path.join(src, "b.md"), "# {{name}}\n");
		nodeFs.writeFileSync(path.join(src, "c.txt"), "{{name}}\n");
		const dest = mktmp("t93-tpl-dest-");
		const written = copyTemplateFiles(src, dest, "my-net");
		expect(written.sort()).toEqual(["a.toml", "b.md", "c.txt"]);
		expect(nodeFs.readFileSync(path.join(dest, "a.toml"), "utf8")).toContain(
			'"my-net"',
		);
		expect(nodeFs.readFileSync(path.join(dest, "b.md"), "utf8")).toContain(
			"# my-net",
		);
		expect(nodeFs.readFileSync(path.join(dest, "c.txt"), "utf8")).toContain(
			"{{name}}",
		);
		expect(nodeFs.existsSync(path.join(dest, "template.toml"))).toBe(false);
	});
});

describe("scaffoldWorkspace", () => {
	tposix("minimal scaffolds, substitutes, stamps, validates", async () => {
		const parent = mktmp("t93-tpl-ws-");
		const res = await scaffoldWorkspace(
			parent,
			"my-net",
			toolEnv(stubCentrsBin()),
		);
		expect(res).toEqual({ ok: true, dir: path.join(parent, "my-net") });
		if (!res.ok) return;
		const wt = nodeFs.readFileSync(
			path.join(res.dir, "workspace.toml"),
			"utf8",
		);
		expect(wt).toContain("my-net");
		expect(wt).not.toContain("{{name}}");
		expect(wt).toMatch(/\[template\]\nname = "minimal"\nversion = "0\.1\.0"/);
		expect(
			nodeFs.readFileSync(path.join(res.dir, "AGENTS.md"), "utf8"),
		).toContain("my-net");
		expect(nodeFs.existsSync(path.join(res.dir, "template.toml"))).toBe(false);
		expect(nodeFs.existsSync(path.join(res.dir, "device.cdb"))).toBe(true);
		expect(nodeFs.existsSync(path.join(res.dir, ".gitignore"))).toBe(true);
		const v = await readAndValidate(res.dir);
		expect(v.ok).toBe(true);
		if (v.ok) {
			expect(v.config.template).toEqual({ name: "minimal", version: "0.1.0" });
		}
	});

	tposix("network scaffolds and validates", async () => {
		const parent = mktmp("t93-tpl-netws-");
		const res = await scaffoldWorkspace(
			parent,
			"full-net",
			toolEnv(stubCentrsBin()),
			"network",
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(nodeFs.existsSync(path.join(res.dir, "START-HERE.md"))).toBe(true);
		expect(
			nodeFs.readFileSync(path.join(res.dir, "workspace.toml"), "utf8"),
		).toMatch(/\[template\]\nname = "network"/);
		expect(nodeFs.existsSync(path.join(res.dir, "template.toml"))).toBe(false);
		const v = await readAndValidate(res.dir);
		expect(v.ok).toBe(true);
		if (v.ok) {
			expect(v.config.template).toEqual({ name: "network", version: "0.1.0" });
		}
	});

	tposix("bad name, existing target, unknown template fail clean", async () => {
		const parent = mktmp("t93-tpl-bad-");
		const env = toolEnv(stubCentrsBin());
		const bad = await scaffoldWorkspace(parent, "../evil", env);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.why).toMatch(/one path segment/);
		nodeFs.mkdirSync(path.join(parent, "taken"));
		const taken = await scaffoldWorkspace(parent, "taken", env);
		expect(taken.ok).toBe(false);
		if (!taken.ok) expect(taken.why).toMatch(/already exists/);
		const unknown = await scaffoldWorkspace(parent, "x", env, "nope");
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.why).toMatch(/unknown template/);
		expect(nodeFs.existsSync(path.join(parent, "x"))).toBe(false);
	});

	tposix("failed devices init rolls the target back", async () => {
		const parent = mktmp("t93-tpl-rollback-");
		const res = await scaffoldWorkspace(
			parent,
			"doomed",
			toolEnv(failingCentrsBin()),
		);
		expect(res.ok).toBe(false);
		expect(nodeFs.existsSync(path.join(parent, "doomed"))).toBe(false);
	});
});

describe("scaffoldIntoDir", () => {
	tposix("conflicts list and nothing is written", async () => {
		const dir = mktmp("t93-tpl-conflict-");
		nodeFs.writeFileSync(path.join(dir, "router.toml"), "mine\n");
		nodeFs.writeFileSync(path.join(dir, "notes.txt"), "mine\n");
		const res = await scaffoldIntoDir(dir, toolEnv(stubCentrsBin()));
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.why).toMatch(/router\.toml/);
			expect(res.conflicts).toContain("router.toml");
		}
		expect(nodeFs.readdirSync(dir).sort()).toEqual([
			"notes.txt",
			"router.toml",
		]);
	});

	tposix("an existing device.cdb is a conflict too", async () => {
		const dir = mktmp("t93-tpl-cdbconf-");
		nodeFs.writeFileSync(path.join(dir, "device.cdb"), "mine\n");
		const res = await scaffoldIntoDir(dir, toolEnv(stubCentrsBin()));
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.conflicts).toContain("device.cdb");
		expect(nodeFs.readFileSync(path.join(dir, "device.cdb"), "utf8")).toBe(
			"mine\n",
		);
	});

	tposix("success into an existing dir names the dir", async () => {
		const dir = mktmp("t93-tpl-intodir-");
		nodeFs.writeFileSync(path.join(dir, "notes.txt"), "mine\n");
		const res = await scaffoldIntoDir(dir, toolEnv(stubCentrsBin()));
		expect(res).toEqual({ ok: true, dir });
		if (!res.ok) return;
		expect(
			nodeFs.readFileSync(path.join(dir, "workspace.toml"), "utf8"),
		).toContain(path.basename(dir));
		expect(nodeFs.existsSync(path.join(dir, "notes.txt"))).toBe(true);
		const v = await readAndValidate(dir);
		expect(v.ok).toBe(true);
	});

	tposix("failed init removes only what it wrote", async () => {
		const dir = mktmp("t93-tpl-intoroll-");
		nodeFs.writeFileSync(path.join(dir, "notes.txt"), "mine\n");
		const res = await scaffoldIntoDir(dir, toolEnv(failingCentrsBin()));
		expect(res.ok).toBe(false);
		expect(nodeFs.readdirSync(dir)).toEqual(["notes.txt"]);
	});
});

describe("validator template acceptance", () => {
	tposix("a malformed [template] still validates, as null", async () => {
		const dir = mktmp("t93-tpl-badprov-");
		nodeFs.writeFileSync(
			path.join(dir, "workspace.toml"),
			'[home]\ntype = "single-copy"\ncanonical = true\n\n[template]\nname = 42\n',
		);
		nodeFs.writeFileSync(path.join(dir, "AGENTS.md"), "# ws\n");
		const v = await readAndValidate(dir);
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.config.template).toBeNull();
	});
});

describe("picker template routes", () => {
	tposix("default approval mode surfaces in chat stats", async () => {
		async function statsAccess(
			defaultApprovalMode?: "allowAll",
		): Promise<unknown[]> {
			const dh = mktmp("t93-tpl-yolodh-");
			const srv = await startServer({
				noWorkspace: true,
				allowOpenCdb: true,
				provider: "echo",
				museHome: mktmp("t93-tpl-yolohome-"),
				cdbFile: path.join(dh, "missing.cdb"),
				dataHome: dh,
				defaultWorkspaceDir: path.join(dh, "nets"),
				toolBinDir: stubCentrsBin(),
				...(defaultApprovalMode ? { defaultApprovalMode } : {}),
			});
			try {
				const before = (await (
					await fetch(`${srv.url}api/chat/stats`)
				).json()) as { access: unknown };
				// Starting the main session tears down the bootstrap
				// worker; the configured mode must survive that (sol
				// review of T93: it fell back to null = "Ask first").
				const sent = await fetch(`${srv.url}api/chat/send`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text: "t93-yolo" }),
				});
				expect(sent.status).toBe(200);
				const after = (await (
					await fetch(`${srv.url}api/chat/stats`)
				).json()) as { access: unknown };
				return [before.access, after.access];
			} finally {
				await srv.stop();
			}
		}
		expect(await statsAccess("allowAll")).toEqual(["allowAll", "allowAll"]);
		const plain = await statsAccess();
		expect(plain).toEqual([null, "onRequest"]);
	});

	tposix("GET lists templates; create honors them", async () => {
		const dh = mktmp("t93-tpl-pickdh-");
		const nets = path.join(dh, "nets");
		const home = mktmp("t93-tpl-pickhome-");
		const srv = await startServer({
			noWorkspace: true,
			allowOpenCdb: true,
			provider: "echo",
			museHome: home,
			cdbFile: path.join(dh, "missing.cdb"),
			dataHome: dh,
			defaultWorkspaceDir: nets,
			toolBinDir: stubCentrsBin(),
		});
		try {
			const list = (await (await fetch(`${srv.url}api/workspaces`)).json()) as {
				templates: { name: string; version: string }[];
				defaultDir: string;
			};
			expect(list.templates.map((t) => t.name)).toEqual(["minimal", "network"]);
			expect(list.defaultDir).toBe(nets);

			// Default create is minimal.
			const dflt = (await (
				await fetch(`${srv.url}api/workspaces`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ action: "create", name: "a-one" }),
				})
			).json()) as { ok: boolean; template: string };
			expect(dflt.ok).toBe(true);
			expect(dflt.template).toBe("minimal");
			expect(
				nodeFs.existsSync(path.join(nets, "a-one", "workspace.toml")),
			).toBe(true);
			expect(nodeFs.existsSync(path.join(nets, "a-one", "START-HERE.md"))).toBe(
				false,
			);

			// Explicit network.
			const net = await fetch(`${srv.url}api/workspaces`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					action: "create",
					name: "b-two",
					template: "network",
				}),
			});
			expect(net.status).toBe(200);
			expect(nodeFs.existsSync(path.join(nets, "b-two", "START-HERE.md"))).toBe(
				true,
			);
			const v = await readAndValidate(path.join(nets, "b-two"));
			expect(v.ok).toBe(true);

			// Unknown template fails honestly.
			const bad = await fetch(`${srv.url}api/workspaces`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					action: "create",
					name: "c-three",
					template: "nope",
				}),
			});
			expect(bad.status).toBe(400);
			const badBody = (await bad.json()) as { ok: boolean; why: string };
			expect(badBody.ok).toBe(false);
			expect(badBody.why).toMatch(/unknown template/);
			expect(nodeFs.existsSync(path.join(nets, "c-three"))).toBe(false);
		} finally {
			await srv.stop();
		}
	});
});
