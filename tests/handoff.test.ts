import { describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listHandoffs } from "../src/steps/handoff";

function makeWs(): string {
	const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "t30-handoff-"));
	nodeFs.mkdirSync(path.join(dir, "operations"), { recursive: true });
	nodeFs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
	return dir;
}

function put(dir: string, rel: string, body: string, ageSec: number): void {
	const full = path.join(dir, rel);
	nodeFs.writeFileSync(full, body);
	const t = new Date(Date.now() - ageSec * 1000);
	nodeFs.utimesSync(full, t, t);
}

describe("handoff listing", () => {
	test("newest first, shaped fields parsed, READMEs skipped", () => {
		const dir = makeWs();
		put(
			dir,
			"operations/001-old-handoff.md",
			"# Old work\nowner: vm-session\nstatus: shaped\n\ndefinition of done: twin proof\n",
			300,
		);
		put(
			dir,
			"operations/002-new-handoff.md",
			"# New work\nowner: app\nstatus: active\n",
			60,
		);
		put(dir, "operations/deployments.md", "# log\n", 10);
		put(dir, "inbox/scrap.md", "half an idea\n", 120);
		put(dir, "inbox/README.md", "# inbox\n", 5);

		const items = listHandoffs(dir);
		expect(items.map((i) => i.rel)).toEqual([
			"operations/002-new-handoff.md",
			"inbox/scrap.md",
			"operations/001-old-handoff.md",
		]);
		const [nh, sc, oh] = items;
		if (!nh || !sc || !oh) throw new Error("expected three handoffs");
		expect(nh.kind).toBe("handoff");
		expect(nh.title).toBe("New work");
		expect(nh.owner).toBe("app");
		expect(nh.status).toBe("active");
		expect(nh.dod).toBe(false);
		expect(oh.dod).toBe(true);
		expect(sc.title).toBe("scrap.md");
	});

	test("empty workspace lists nothing", () => {
		const dir = makeWs();
		expect(listHandoffs(dir)).toEqual([]);
	});
});
