import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	routerosSkillsManifest,
	type SkillsBundle,
	type SkillsIo,
	stageRouterosSkills,
} from "../src/lib/routeros-skills";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";

afterAll(cleanupTmpdirs);

function home(): string {
	const h = mktmp("t128-home-");
	fs.mkdirSync(path.join(h, "muse"));
	return h;
}
function bundle(version: string, extra = false): SkillsBundle {
	const files = () =>
		new Map([
			["SKILL.md", Buffer.from(version)],
			...(extra
				? [["new.md", Buffer.from(`new ${version}`)] as [string, Buffer]]
				: []),
			["references/ref.md", Buffer.from(`ref ${version}`)],
		]);
	return {
		source: `github:tikoci/routeros-skills#${version.repeat(40)}`,
		revision: version.repeat(40),
		skills: new Map([
			["routeros-a", files()],
			["routeros-b", files()],
		]),
	};
}
function file(h: string, name = "routeros-a", rel = "SKILL.md") {
	return path.join(h, "muse", "skills", name, rel);
}
function run(
	h: string,
	enabled: boolean,
	source?: SkillsBundle,
	io?: SkillsIo,
) {
	return stageRouterosSkills({ privateHome: h, enabled, bundle: source, io });
}
function fail(): never {
	throw Object.assign(new Error("injected EACCES"), { code: "EACCES" });
}
function failRename(target: string): SkillsIo {
	return {
		renameSync(from, to) {
			if (to === target) fail();
			fs.renameSync(from, to);
		},
	};
}
function expectBundle(h: string, source: SkillsBundle) {
	for (const [name, files] of source.skills)
		for (const [rel, bytes] of files)
			expect(fs.readFileSync(file(h, name, rel), "utf8")).toBe(
				bytes.toString(),
			);
}

describe("T128 interrupted ownership recovery", () => {
	for (const target of [
		"routeros-b/SKILL.md",
		"routeros-a/references/ref.md",
	]) {
		test(`retry heals an upgrade interrupted at ${target}, including new files`, () => {
			const h = home();
			run(h, true, bundle("a"));
			const next = bundle("b", true);
			expect(() =>
				run(h, true, next, failRename(path.join(h, "muse", "skills", target))),
			).toThrow("injected EACCES");
			expect(fs.readFileSync(file(h), "utf8")).toBe("b");
			const retried = run(h, true, next);
			expect(retried.staged).toEqual(["routeros-a", "routeros-b"]);
			expect(retried.warnings).toEqual([]);
			expectBundle(h, next);
			expect(run(h, true, next).warnings).toEqual([]);
			expect(run(h, false).warnings).toEqual([]);
			expect(fs.existsSync(file(h))).toBe(false);
			expect(fs.existsSync(file(h, "routeros-b"))).toBe(false);
		});
	}
	test("off prunes successfully replaced bytes without a successful retry", () => {
		const h = home();
		run(h, true, bundle("a"));
		expect(() =>
			run(h, true, bundle("b", true), failRename(file(h, "routeros-b"))),
		).toThrow();
		expect(run(h, false).warnings).toEqual([]);
		expect(fs.existsSync(file(h))).toBe(false);
		expect(fs.existsSync(file(h, "routeros-a", "new.md"))).toBe(false);
	});
	for (const action of ["retry", "off"]) {
		test(`manifest write failure after replacement permits ${action}`, () => {
			const h = home();
			run(h, true, bundle("a"));
			let replaced = false;
			const io: SkillsIo = {
				renameSync(from, to) {
					if (replaced && to === routerosSkillsManifest(h)) fail();
					fs.renameSync(from, to);
					if (to === file(h)) replaced = true;
				},
			};
			expect(() => run(h, true, bundle("b"), io)).toThrow("injected EACCES");
			expect(fs.readFileSync(file(h), "utf8")).toBe("b");
			const report =
				action === "retry" ? run(h, true, bundle("b")) : run(h, false);
			expect(report.warnings).toEqual([]);
			if (action === "retry") expectBundle(h, bundle("b"));
			else expect(fs.existsSync(file(h))).toBe(false);
		});
	}
	test("pre-existing matching files inside an owned skill are not adopted", () => {
		const h = home();
		run(h, true, bundle("a"));
		fs.writeFileSync(file(h, "routeros-a", "new.md"), "new b");
		const report = run(h, true, bundle("b", true));
		expect(report.bundledCount).toBe(2);
		expect(report.staged).toEqual(["routeros-b"]);
		expect(report.warnings.join()).toContain("unowned files");
		run(h, false);
		expect(fs.readFileSync(file(h, "routeros-a", "new.md"), "utf8")).toBe(
			"new b",
		);
	});
	test("an owner's edit matching the next release is not mistaken for recovery", () => {
		const h = home();
		run(h, true, bundle("a"));
		fs.writeFileSync(file(h), "b");
		expect(run(h, true, bundle("b")).warnings.join()).toContain("local edits");
		run(h, false);
		expect(fs.readFileSync(file(h), "utf8")).toBe("b");
	});
	test("legacy v1 manifests migrate without rewriting their skill files", () => {
		const h = home();
		run(h, true, bundle("a"));
		const manifest = routerosSkillsManifest(h);
		const doc = JSON.parse(fs.readFileSync(manifest, "utf8"));
		doc.version = 1;
		fs.writeFileSync(manifest, JSON.stringify(doc));
		const inode = fs.statSync(file(h)).ino;
		expect(run(h, true, bundle("a")).warnings).toEqual([]);
		expect(fs.statSync(file(h)).ino).toBe(inode);
		expect(JSON.parse(fs.readFileSync(manifest, "utf8")).version).toBe(2);
	});
	test("invalid pending hashes are rejected before changing owned files", () => {
		const h = home();
		run(h, true, bundle("a"));
		const manifest = routerosSkillsManifest(h);
		const doc = JSON.parse(fs.readFileSync(manifest, "utf8"));
		for (const bad of [[], ["bad"], ["a".repeat(64), "bad"]]) {
			doc.skills["routeros-a"]["SKILL.md"] = bad;
			fs.writeFileSync(manifest, JSON.stringify(doc));
			expect(() => run(h, false)).toThrow("invalid manifest file or hash");
			expect(fs.readFileSync(file(h), "utf8")).toBe("a");
		}
	});
	test("failure to record a new create removes that create and allows a later retry", () => {
		const h = home();
		expect(() =>
			run(h, true, bundle("a"), {
				linkSync(from, to) {
					if (to === routerosSkillsManifest(h)) fail();
					fs.linkSync(from, to);
				},
			}),
		).toThrow("injected EACCES");
		expect(fs.existsSync(file(h))).toBe(false);
		expect(run(h, true, bundle("a")).warnings).toEqual([]);
		expectBundle(h, bundle("a"));
	});
	test("local edits after a failed upgrade remain protected on retry and off", () => {
		const h = home();
		run(h, true, bundle("a"));
		expect(() =>
			run(h, true, bundle("b"), failRename(file(h, "routeros-b"))),
		).toThrow();
		fs.writeFileSync(file(h), "owner edit");
		expect(run(h, true, bundle("b")).warnings.join()).toContain("local edits");
		expect(run(h, false).warnings.join()).toContain("local edit preserved");
		expect(fs.readFileSync(file(h), "utf8")).toBe("owner edit");
	});
	test("cleanup after a recording failure never removes a competing replacement", () => {
		const h = home();
		const replacement = path.join(h, "replacement");
		fs.writeFileSync(replacement, "a");
		expect(() =>
			run(h, true, bundle("a"), {
				linkSync(from, to) {
					if (to === routerosSkillsManifest(h)) {
						fs.renameSync(replacement, file(h));
						fail();
					}
					fs.linkSync(from, to);
				},
			}),
		).toThrow("injected EACCES");
		expect(fs.readFileSync(file(h), "utf8")).toBe("a");
		expect(run(h, true, bundle("a")).warnings.join()).toContain("not managed");
	});
});
