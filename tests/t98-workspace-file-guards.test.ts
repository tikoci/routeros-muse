import { afterAll, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	listWorkspaceFiles,
	MAX_FILE_BYTES,
	readTomlSections,
	readWorkspaceFile,
	writeWorkspaceFile,
} from "../src/lib/workspace";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";

afterAll(cleanupTmpdirs);
function fixture() {
	const home = mktmp("t98-");
	const root = path.join(home, "workspace");
	fs.mkdirSync(root);
	return { home, root };
}

for (const name of ["device.cdb", "device.cdb.bak.123", "DEVICE.CDB"]) {
	for (const op of ["read", "write"] as const) {
		test(`credential name denied: ${name} ${op}`, () => {
			const { root } = fixture();
			fs.writeFileSync(path.join(root, name), "credential");
			expect(
				(op === "read"
					? readWorkspaceFile(root, name)
					: writeWorkspaceFile(root, name, "changed")
				).status,
			).toBe(400);
			expect(fs.readFileSync(path.join(root, name), "utf8")).toBe("credential");
		});
	}
}

test("credential directory component denied by all routes", () => {
	const { root } = fixture();
	fs.mkdirSync(path.join(root, "device.cdb.bak.123"));
	fs.writeFileSync(
		path.join(root, "device.cdb.bak.123/settings.toml"),
		"x = 1",
	);
	const rel = "device.cdb.bak.123/settings.toml";
	expect(readWorkspaceFile(root, rel).status).toBe(400);
	expect(readTomlSections(root, rel).status).toBe(400);
	expect(writeWorkspaceFile(root, rel, "x = 2").status).toBe(400);
});

for (const op of ["read", "write", "toml"] as const) {
	test(`symlink to credential store denied: ${op}`, () => {
		const { root } = fixture();
		fs.writeFileSync(path.join(root, "device.cdb"), "x = 1");
		fs.symlinkSync("device.cdb", path.join(root, "alias.toml"));
		const result =
			op === "read"
				? readWorkspaceFile(root, "alias.toml")
				: op === "toml"
					? readTomlSections(root, "alias.toml")
					: writeWorkspaceFile(root, "alias.toml", "x = 2");
		expect(result.status).toBe(400);
		expect(fs.readFileSync(path.join(root, "device.cdb"), "utf8")).toBe(
			"x = 1",
		);
	});
	test(`outside symlink denied: ${op}, outside bytes preserved`, () => {
		const { home, root } = fixture();
		const outside = path.join(home, "outside.toml");
		fs.writeFileSync(outside, "x = 1");
		fs.symlinkSync(outside, path.join(root, "alias.toml"));
		const result =
			op === "read"
				? readWorkspaceFile(root, "alias.toml")
				: op === "toml"
					? readTomlSections(root, "alias.toml")
					: writeWorkspaceFile(root, "alias.toml", "x = 2");
		expect(fs.readFileSync(outside, "utf8")).toBe("x = 1");
		expect(result.status).toBe(400);
	});
}

test("outside symlink directory component denied by all routes", () => {
	const { home, root } = fixture();
	fs.mkdirSync(path.join(home, "outside"));
	fs.writeFileSync(path.join(home, "outside/settings.toml"), "x = 1");
	fs.symlinkSync(path.join(home, "outside"), path.join(root, "linked"));
	expect(readWorkspaceFile(root, "linked/settings.toml").status).toBe(400);
	expect(readTomlSections(root, "linked/settings.toml").status).toBe(400);
	expect(writeWorkspaceFile(root, "linked/new.toml", "x = 2").status).toBe(400);
	expect(fs.existsSync(path.join(home, "outside/new.toml"))).toBe(false);
});

for (const call of [
	"readWorkspaceFile(root, 'pipe.toml')",
	"readTomlSections(root, 'pipe.toml')",
	"writeWorkspaceFile(root, 'pipe.toml', 'x = 2')",
]) {
	test(`FIFO returns 400 without hanging: ${call}`, () => {
		const { root } = fixture();
		expect(spawnSync("mkfifo", [path.join(root, "pipe.toml")]).status).toBe(0);
		const module = path.resolve(import.meta.dir, "../src/lib/workspace.ts");
		const child = spawnSync(
			process.execPath,
			[
				"-e",
				`import {readWorkspaceFile,readTomlSections,writeWorkspaceFile} from ${JSON.stringify(module)}; const root=${JSON.stringify(root)}; console.log(JSON.stringify(${call}));`,
			],
			{ timeout: 2000, encoding: "utf8" },
		);
		expect(child.error).toBeUndefined();
		expect(child.status).toBe(0);
		expect(JSON.parse(child.stdout).status).toBe(400);
	});
}

test("TOML read cap is 512 KiB", () => {
	const { root } = fixture();
	fs.writeFileSync(
		path.join(root, "large.toml"),
		`#${" ".repeat(MAX_FILE_BYTES)}`,
	);
	expect(readTomlSections(root, "large.toml").status).toBe(400);
	expect(readWorkspaceFile(root, "large.toml").status).toBe(400);
	fs.writeFileSync(
		path.join(root, "large.toml"),
		`#${" ".repeat(MAX_FILE_BYTES - 1)}`,
	);
	expect(readTomlSections(root, "large.toml").status).toBe(200);
});

test("ordinary reads, new nested writes, replacement and TOML editor drift", () => {
	const { root } = fixture();
	expect(writeWorkspaceFile(root, "notes/doc.md", "hello").status).toBe(200);
	expect(readWorkspaceFile(root, "notes/doc.md").body).toMatchObject({
		text: "hello",
	});
	expect(writeWorkspaceFile(root, "notes/doc.md", "hi").status).toBe(200);
	expect(fs.readFileSync(path.join(root, "notes/doc.md"), "utf8")).toBe("hi");
	expect(
		writeWorkspaceFile(root, "settings.toml", "[config]\nx = 1").status,
	).toBe(200);
	expect(
		writeWorkspaceFile(root, "settings.toml", "[config]\nx = 2", {
			fromTomlEditor: true,
		}).status,
	).toBe(200);
	expect(readTomlSections(root, "settings.toml").status).toBe(200);
	expect(
		writeWorkspaceFile(root, "settings.toml", "[config]\nx = 'two'", {
			fromTomlEditor: true,
		}).status,
	).toBe(409);
	expect(writeWorkspaceFile(root, "settings.toml", "[broken").status).toBe(400);
});

test("template latest is offered by tree and readable, but never writable", () => {
	const { root } = fixture();
	fs.mkdirSync(path.join(root, "observations/dev/capture-N"), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(root, "observations/dev/capture-N/settings.toml"),
		"x = 1",
	);
	fs.symlinkSync("capture-N", path.join(root, "observations/dev/latest"));
	const rel = "observations/dev/latest/settings.toml";
	expect(listWorkspaceFiles(root).some((entry) => entry.path === rel)).toBe(
		true,
	);
	expect(readWorkspaceFile(root, rel).body).toMatchObject({ text: "x = 1" });
	expect(readTomlSections(root, rel).status).toBe(200);
	expect(
		writeWorkspaceFile(root, rel, "x = 2", { fromTomlEditor: true }).status,
	).toBe(400);
	expect(
		fs.readFileSync(
			path.join(root, "observations/dev/capture-N/settings.toml"),
			"utf8",
		),
	).toBe("x = 1");
});

test("link chains cannot launder a credential component", () => {
	const { root } = fixture();
	fs.mkdirSync(path.join(root, "private.cdb"));
	fs.writeFileSync(path.join(root, "private.cdb/settings.toml"), "x = 1");
	fs.symlinkSync("private.cdb", path.join(root, "middle"));
	fs.symlinkSync("middle/settings.toml", path.join(root, "alias.toml"));
	expect(readWorkspaceFile(root, "alias.toml").status).toBe(400);
	expect(readTomlSections(root, "alias.toml").status).toBe(400);
});

test("new credential files and loops are refused; missing files stay 404", () => {
	const { root } = fixture();
	expect(writeWorkspaceFile(root, "new.cdb", "credential").status).toBe(400);
	expect(fs.existsSync(path.join(root, "new.cdb"))).toBe(false);
	fs.symlinkSync("loop.toml", path.join(root, "loop.toml"));
	expect(readWorkspaceFile(root, "loop.toml").status).toBe(400);
	expect(readTomlSections(root, "loop.toml").status).toBe(400);
	expect(readWorkspaceFile(root, "missing.md").status).toBe(404);
});

test("trusted root symlink and absolute internal read links work", () => {
	const { home, root } = fixture();
	const alias = path.join(home, "workspace-alias");
	fs.symlinkSync(root, alias);
	fs.writeFileSync(path.join(root, "real.toml"), "x = 1");
	fs.symlinkSync(path.join(root, "real.toml"), path.join(root, "alias.toml"));
	expect(readWorkspaceFile(alias, "alias.toml").status).toBe(200);
	expect(readTomlSections(alias, "alias.toml").status).toBe(200);
	expect(writeWorkspaceFile(alias, "alias.toml", "x = 2").status).toBe(400);
});

test("new-file save never clobbers a competing create after preflight", () => {
	const { root } = fixture();
	const target = path.join(root, "new.md");
	const mkdir = fs.mkdirSync;
	const hook = spyOn(fs, "mkdirSync").mockImplementation(((
		...args: Parameters<typeof fs.mkdirSync>
	) => {
		const result = (mkdir as (...args: unknown[]) => unknown)(...args);
		fs.writeFileSync(target, "competing writer");
		return result;
	}) as typeof fs.mkdirSync);
	try {
		expect(writeWorkspaceFile(root, "new.md", "our text").status).toBe(400);
		expect(fs.readFileSync(target, "utf8")).toBe("competing writer");
	} finally {
		hook.mockRestore();
	}
});
