import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	compareRouterosCatalogs,
	loadRouterosSkills,
	routerosSkillsManifest,
	type SkillsBundle,
	stageRouterosSkills,
} from "../src/lib/routeros-skills";
import {
	readAutoRouterosSkills,
	settingsFile,
	writeAutoRouterosSkills,
} from "../src/lib/settings";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";

afterAll(cleanupTmpdirs);

function home(): string {
	const dir = mktmp("t100-home-");
	fs.mkdirSync(path.join(dir, "muse"));
	return dir;
}
function skill(home: string, rel = "SKILL.md"): string {
	return path.join(home, "muse", "skills", "routeros-test", rel);
}
function bundle(body = "original", revision = "a"): SkillsBundle {
	return {
		source: `github:tikoci/routeros-skills#${revision.repeat(40)}`,
		revision: revision.repeat(40),
		skills: new Map([
			[
				"routeros-test",
				new Map([
					["SKILL.md", Buffer.from(body)],
					["references/nested/reference.md", Buffer.from(`reference: ${body}`)],
				]),
			],
		]),
	};
}
function stage(privateHome: string, enabled = true, source = bundle()) {
	return stageRouterosSkills({ privateHome, enabled, bundle: source });
}

describe("T100 owned skills delivery", () => {
	test("installs the real pinned dependency and all references, independently of cwd", () => {
		const b = loadRouterosSkills();
		expect(b.revision).toBe("37f271ff0195745aeac727daa74482d2c2abb75c");
		expect(b.skills.size).toBe(19);
		const h = home();
		const report = stage(h, true, b);
		expect(report.staged).toHaveLength(19);
		for (const [name, files] of b.skills)
			for (const [rel, bytes] of files)
				expect(
					Buffer.compare(
						fs.readFileSync(path.join(h, "muse", "skills", name, rel)),
						bytes,
					),
				).toBe(0);
		const doc = JSON.parse(fs.readFileSync(routerosSkillsManifest(h), "utf8"));
		expect(doc.source).toBe(b.source);
		expect(doc.skills["routeros-fundamentals"]["SKILL.md"]).toMatch(
			/^[a-f0-9]{64}$/,
		);
	});
	test("repeated start is byte- and inode-stable; a package upgrade updates references too", () => {
		const h = home();
		stage(h);
		const before = fs.statSync(skill(h)).ino;
		const manifestBefore = fs.statSync(routerosSkillsManifest(h)).ino;
		stage(h);
		expect(fs.statSync(skill(h)).ino).toBe(before);
		expect(fs.statSync(routerosSkillsManifest(h)).ino).toBe(manifestBefore);
		stage(h, true, bundle("upgraded", "b"));
		expect(fs.readFileSync(skill(h), "utf8")).toBe("upgraded");
		expect(
			fs.readFileSync(skill(h, "references/nested/reference.md"), "utf8"),
		).toBe("reference: upgraded");
	});
	test("off prunes only owned files, preserving an unrelated skill and additions", () => {
		const h = home();
		stage(h);
		const personal = path.join(h, "muse", "skills", "personal", "SKILL.md");
		fs.mkdirSync(path.dirname(personal));
		fs.writeFileSync(personal, "personal");
		fs.writeFileSync(skill(h, "my-notes.md"), "notes");
		expect(stage(h, false).staged).toEqual([]);
		expect(fs.existsSync(skill(h))).toBe(false);
		expect(fs.readFileSync(personal, "utf8")).toBe("personal");
		expect(fs.readFileSync(skill(h, "my-notes.md"), "utf8")).toBe("notes");
		// Retained notes do not block re-enable or become package-owned.
		expect(stage(h).staged).toEqual(["routeros-test"]);
		expect(fs.readFileSync(skill(h, "my-notes.md"), "utf8")).toBe("notes");
	});
	test("unowned same-name skill is neither overwritten nor adopted, even if byte-identical", () => {
		const h = home();
		fs.mkdirSync(path.dirname(skill(h)), { recursive: true });
		fs.writeFileSync(skill(h), "original");
		expect(stage(h).warnings.join()).toContain("not managed");
		stage(h, false);
		expect(fs.readFileSync(skill(h), "utf8")).toBe("original");
	});
	test("updates preserve edits and off retains changed files with an explicit warning", () => {
		const h = home();
		stage(h);
		fs.writeFileSync(skill(h), "owner edit");
		expect(stage(h, true, bundle("upgrade", "b")).warnings.join()).toContain(
			"local edits",
		);
		expect(fs.readFileSync(skill(h), "utf8")).toBe("owner edit");
		expect(stage(h, false).warnings.join()).toContain("may still load");
		expect(fs.readFileSync(skill(h), "utf8")).toBe("owner edit");
		expect(fs.existsSync(skill(h, "references/nested/reference.md"))).toBe(
			false,
		);
	});
	test("an unowned file colliding with a new package file blocks that skill's upgrade", () => {
		const h = home();
		stage(h);
		fs.writeFileSync(skill(h, "new.md"), "owner file");
		const next = bundle("upgrade", "b");
		next.skills
			.get("routeros-test")
			?.set("new.md", Buffer.from("package file"));
		expect(stage(h, true, next).warnings.join()).toContain("unowned files");
		expect(fs.readFileSync(skill(h), "utf8")).toBe("original");
		expect(fs.readFileSync(skill(h, "new.md"), "utf8")).toBe("owner file");
	});
	test("a removed upstream skill is pruned; a missing owned file is repaired", () => {
		const h = home();
		stage(h);
		fs.unlinkSync(skill(h));
		stage(h);
		expect(fs.readFileSync(skill(h), "utf8")).toBe("original");
		const next = bundle();
		next.skills.clear();
		stage(h, true, next);
		expect(fs.existsSync(path.dirname(skill(h)))).toBe(false);
	});
	for (const target of [
		"skills",
		"routeros-muse-skills.json",
		"skills/routeros-test",
		"skills/routeros-test/references",
		"skills/routeros-test/SKILL.md",
	]) {
		test(`refuses a symlink at ${target} without changing the external target`, () => {
			const h = home();
			stage(h);
			const outside = mktmp("t100-outside-");
			const fileTarget = target.endsWith(".json") || target.endsWith(".md");
			const external = fileTarget ? path.join(outside, "sentinel") : outside;
			if (fileTarget) fs.writeFileSync(external, "sentinel");
			const link = path.join(h, "muse", target);
			fs.rmSync(link, { recursive: true });
			fs.symlinkSync(external, link);
			expect(() => stage(h, false)).toThrow();
			expect(fs.readdirSync(outside)).toEqual(fileTarget ? ["sentinel"] : []);
			if (fileTarget)
				expect(fs.readFileSync(external, "utf8")).toBe("sentinel");
		});
	}
	test("a traversal in the manifest refuses all mutation and releases the lock", () => {
		const h = home();
		stage(h);
		const manifest = routerosSkillsManifest(h);
		const doc = JSON.parse(fs.readFileSync(manifest, "utf8"));
		doc.skills["routeros-test"]["../../sentinel"] = "a".repeat(64);
		fs.writeFileSync(manifest, JSON.stringify(doc));
		expect(() => stage(h, false)).toThrow("invalid manifest file");
		expect(fs.readFileSync(skill(h), "utf8")).toBe("original");
		expect(fs.readdirSync(path.join(h, "muse"))).not.toContain(
			".routeros-muse-skills.lock",
		);
	});
	test("a live delivery lock is never stolen; a dead owner's lock is recovered", () => {
		const h = home();
		const lock = path.join(h, "muse", ".routeros-muse-skills.lock");
		fs.writeFileSync(lock, String(process.pid));
		expect(() => stage(h)).toThrow("another process");
		expect(fs.readFileSync(lock, "utf8")).toBe(String(process.pid));
		fs.writeFileSync(lock, "2147483647");
		expect(stage(h).staged).toEqual(["routeros-test"]);
		expect(fs.existsSync(lock)).toBe(false);
	});
	test("missing packages and moving revisions fail loudly", () => {
		const pkg = mktmp("t100-pkg-");
		fs.writeFileSync(
			path.join(pkg, "package.json"),
			JSON.stringify({
				dependencies: {
					"routeros-skills": "github:tikoci/routeros-skills#main",
				},
			}),
		);
		expect(() => loadRouterosSkills(pkg)).toThrow("full Git SHA");
		fs.writeFileSync(
			path.join(pkg, "package.json"),
			JSON.stringify({ dependencies: { "routeros-skills": bundle().source } }),
		);
		expect(() => loadRouterosSkills(pkg)).toThrow("package missing");
	});
});

test("T100 machine opt-out preserves existing settings and defaults on", () => {
	const dh = mktmp("t100-settings-");
	expect(readAutoRouterosSkills(dh)).toBe(true);
	const file = settingsFile(dh);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		'# keep\n[agent]\npreallow_reads = false\n[other]\nvalue = "preserved"\n',
	);
	writeAutoRouterosSkills(dh, false);
	expect(readAutoRouterosSkills(dh)).toBe(false);
	expect(fs.readFileSync(file, "utf8")).toContain(
		'preallow_reads = false\n[other]\nvalue = "preserved"',
	);
	writeAutoRouterosSkills(dh, true);
	expect(readAutoRouterosSkills(dh)).toBe(true);
});

test("T100 catalog check distinguishes missing skills, workspace overrides and personal-copy notices", () => {
	const args = {
		bundle: bundle(),
		staged: ["routeros-test"],
		privateHome: "/private",
		msp: { skills: [{ selector: "routeros-test", source: "user" }] },
		cli: {
			skills: [
				{
					name: "routeros-test",
					scope: "user",
					path: "$CONFIG_DIR/skills/routeros-test/SKILL.md",
					activation: "on",
				},
			],
			diagnostics: [
				{
					code: "skill-shadowed",
					path: "$HOME/.agents/skills/routeros-test/SKILL.md",
					message: "shadowed",
				},
			],
		},
	};
	expect(compareRouterosCatalogs(args)).toEqual({
		loaded: ["routeros-test"],
		workspaceOverrides: [],
		personalCopiesShadowed: 1,
		warnings: [],
	});
	args.msp.skills = [];
	expect(compareRouterosCatalogs(args).warnings.join()).toContain(
		"session catalog",
	);
	args.bundle.skills
		.get("routeros-test")
		?.set("SKILL.md", Buffer.from("user-invocable: false\n"));
	expect(compareRouterosCatalogs(args).loaded).toEqual(["routeros-test"]);
	const row = args.cli.skills[0];
	if (!row) throw new Error("missing catalog fixture");
	row.scope = "project";
	expect(compareRouterosCatalogs(args).workspaceOverrides).toEqual([
		"routeros-test",
	]);
	args.cli.skills = [];
	expect(compareRouterosCatalogs(args).warnings.join()).toContain(
		"full catalog",
	);
});
