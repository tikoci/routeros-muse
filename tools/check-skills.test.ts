// Anchor tests for check-skills.ts on tmp-dir fixtures. Run: bun test (in tools/).
import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cleanupTmpdirs, mktmp } from "../tests/helpers/tmp";
import {
	frontVal,
	isPlaybookSkill,
	parseFlowList,
	refsStatus,
	runSkillTest,
	splitFrontmatter,
	verifyMeta,
	verifyPlaybook,
	verifyRefs,
	verifyShape,
	verifySkill,
	verifyTested,
} from "./check-skills";

afterAll(cleanupTmpdirs);

const GOOD = (name: string, extra = ""): string => `---
name: ${name}
description: "AFine skill used only by tests."
topics: [workspace]
tested: none
${extra}---

# ${name}

## Part 1 — The checklist

1. First step.
2. Second step.
3. Third step.

## Part 2 — Skill doc

### Trigger

### Prereqs

### Access

### Envs

### Outputs

### Verification

### Recovery

### Limits
`;

function skillTree(files: Record<string, string>, exec: string[] = []): string {
	const root = mktmp("skills-");
	for (const [rel, content] of Object.entries(files)) {
		const p = join(root, rel);
		mkdirSync(join(p, ".."), { recursive: true });
		writeFileSync(p, content);
	}
	for (const rel of exec) chmodSync(join(root, rel), 0o755);
	return root;
}

describe("frontmatter", () => {
	test("splits frontmatter from body", () => {
		const s = splitFrontmatter(GOOD("demo"));
		expect(s?.front).toContain("name: demo");
		expect(s?.body).toStartWith("\n# demo");
	});
	test("missing frontmatter returns null", () => {
		expect(splitFrontmatter("# no frontmatter\n")).toBeNull();
	});
	test("frontVal unquotes and playbook defaults true", () => {
		const s = splitFrontmatter(GOOD("demo"));
		if (!s) throw new Error("fixture must parse");
		expect(frontVal(s.front, "name")).toBe("demo");
		expect(isPlaybookSkill(s.front)).toBe(true);
		const g = splitFrontmatter(GOOD("demo", "playbook: false\n"));
		if (!g) throw new Error("fixture must parse");
		expect(isPlaybookSkill(g.front)).toBe(false);
	});
});

describe("shape", () => {
	test("good skill passes", () => {
		expect(verifyShape("demo", GOOD("demo"))).toEqual([]);
	});
	test("name mismatch fails", () => {
		expect(verifyShape("other", GOOD("demo")).join("\n")).toContain(
			"does not match directory",
		);
	});
	test("missing H1 fails", () => {
		expect(
			verifyShape(
				"demo",
				'---\nname: demo\ndescription: "d"\n---\n\nNo heading here.\n',
			).join("\n"),
		).toContain("expected an H1");
	});
	test("overlong description fails", () => {
		const big =
			'---\nname: demo\ndescription: "' +
			"x".repeat(1025) +
			'"\n---\n\n# demo\n';
		expect(verifyShape("demo", big).join("\n")).toContain("max 1024");
	});
});

describe("playbook", () => {
	test("good recipe passes", () => {
		expect(verifyPlaybook(GOOD("demo"))).toEqual([]);
	});
	test("missing Part 1 fails", () => {
		const t = GOOD("demo").replace(
			"## Part 1 — The checklist",
			"## Something else",
		);
		expect(verifyPlaybook(t).join("\n")).toContain("without `## Part 1`");
	});
	test("too few steps fails", () => {
		const t = GOOD("demo").replace("3. Third step.\n", "");
		expect(verifyPlaybook(t).join("\n")).toContain("numbered steps");
	});
	test("missing recipe section fails", () => {
		const t = GOOD("demo").replace("### Limits\n", "");
		expect(verifyPlaybook(t).join("\n")).toContain("### Limits");
	});
	test("playbook:false skips all playbook checks", () => {
		const t =
			'---\nname: demo\nplaybook: false\ndescription: "d"\n---\n\n# demo\n\nNo checklist at all.\n';
		expect(verifyPlaybook(t)).toEqual([]);
	});
});

describe("meta", () => {
	const front = (body: string): string => {
		const s = splitFrontmatter(body);
		if (!s) throw new Error("fixture must parse");
		return s.front;
	};
	test("good meta passes", () => {
		expect(verifyMeta("demo", front(GOOD("demo")))).toEqual([]);
	});
	test("missing topics fails", () => {
		const t = GOOD("demo").replace("topics: [workspace]\n", "");
		expect(verifyMeta("demo", front(t)).join("\n")).toContain(
			"missing `topics:`",
		);
	});
	test("block-style topics fails (flow only)", () => {
		const t = GOOD("demo").replace(
			"topics: [workspace]",
			"topics:\n  - workspace",
		);
		expect(verifyMeta("demo", front(t)).join("\n")).toContain("flow list");
	});
	test("unknown topic fails", () => {
		const t = GOOD("demo").replace(
			"[workspace]",
			"[workspace, definitely-not-a-topic]",
		);
		expect(verifyMeta("demo", front(t)).join("\n")).toContain(
			'unknown topic "definitely-not-a-topic"',
		);
	});
	test("unknown requires fails, omitted requires passes", () => {
		const bad = GOOD("demo").replace(
			"tested: none",
			"requires: [twin, hoverboard]\ntested: none",
		);
		expect(verifyMeta("demo", front(bad)).join("\n")).toContain(
			'unknown requires "hoverboard"',
		);
		expect(verifyMeta("demo", front(GOOD("demo")))).toEqual([]);
	});
	test("missing or bogus tested fails", () => {
		const missing = GOOD("demo").replace("tested: none\n", "");
		expect(verifyMeta("demo", front(missing)).join("\n")).toContain(
			"missing `tested:`",
		);
		const bogus = GOOD("demo").replace("tested: none", "tested: vibes");
		expect(verifyMeta("demo", front(bogus)).join("\n")).toContain(
			"must be one of",
		);
	});
	test("parseFlowList handles quotes and empties", () => {
		expect(parseFlowList("[a, b]")).toEqual(["a", "b"]);
		expect(parseFlowList("[]")).toEqual([]);
		expect(parseFlowList("nope")).toBeNull();
	});
});

describe("tested levels", () => {
	const front = (body: string): string => {
		const s = splitFrontmatter(body);
		if (!s) throw new Error("fixture must parse");
		return s.front;
	};
	test("tested:none needs nothing", () => {
		const root = skillTree({ "demo/SKILL.md": GOOD("demo") });
		try {
			expect(verifyTested(join(root, "demo"), front(GOOD("demo")))).toEqual([]);
		} finally {
			rmSync(root, { recursive: true });
		}
	});
	test("tested:self-test without test.sh fails", () => {
		const t = GOOD("demo").replace("tested: none", "tested: self-test");
		const root = skillTree({ "demo/SKILL.md": t });
		try {
			expect(verifyTested(join(root, "demo"), front(t)).join("\n")).toContain(
				"requires references/test.sh",
			);
		} finally {
			rmSync(root, { recursive: true });
		}
	});
	test("tested:twin-run needs dated twin-run.md", () => {
		const t = GOOD("demo").replace("tested: none", "tested: twin-run");
		const root = skillTree(
			{ "demo/SKILL.md": t, "demo/references/test.sh": "#!/bin/sh\nexit 0\n" },
			["demo/references/test.sh"],
		);
		try {
			const dir = join(root, "demo");
			expect(verifyTested(dir, front(t)).join("\n")).toContain(
				"requires references/twin-run.md",
			);
			writeFileSync(
				join(dir, "references/twin-run.md"),
				"ran on twin-x, no date here\n",
			);
			expect(verifyTested(dir, front(t)).join("\n")).toContain(
				"must cite a date",
			);
			writeFileSync(
				join(dir, "references/twin-run.md"),
				"twin4 2026-10-29: centrs retrieve /system/resource\n",
			);
			expect(verifyTested(dir, front(t))).toEqual([]);
		} finally {
			rmSync(root, { recursive: true });
		}
	});
});

describe("references", () => {
	test("absent references passes", () => {
		const root = skillTree({ "demo/SKILL.md": GOOD("demo") });
		try {
			expect(refsStatus(join(root, "demo"))).toBeNull();
			expect(verifyRefs(join(root, "demo"))).toEqual([]);
		} finally {
			rmSync(root, { recursive: true });
		}
	});
	test("code without test.sh fails", () => {
		const root = skillTree({
			"demo/SKILL.md": GOOD("demo"),
			"demo/references/probe.sh": "#!/bin/sh\nexit 0\n",
		});
		try {
			expect(verifyRefs(join(root, "demo")).join("\n")).toContain(
				"no test.sh entrypoint",
			);
		} finally {
			rmSync(root, { recursive: true });
		}
	});
	test("non-executable test.sh fails", () => {
		const root = skillTree({
			"demo/SKILL.md": GOOD("demo"),
			"demo/references/test.sh": "#!/bin/sh\nexit 0\n",
		});
		try {
			expect(verifyRefs(join(root, "demo")).join("\n")).toContain(
				"not executable",
			);
		} finally {
			rmSync(root, { recursive: true });
		}
	});
	test("passing test.sh runs green end to end", async () => {
		const root = skillTree(
			{
				"demo/SKILL.md": GOOD("demo"),
				"demo/references/test.sh": "#!/bin/sh\necho proved\n",
			},
			["demo/references/test.sh"],
		);
		try {
			expect(await verifySkill(root, "demo")).toEqual([]);
			const r = await runSkillTest(join(root, "demo"));
			expect(r.ok).toBe(true);
			expect(r.output).toContain("proved");
		} finally {
			rmSync(root, { recursive: true });
		}
	});
	test("failing test.sh fails end to end", async () => {
		const root = skillTree(
			{
				"demo/SKILL.md": GOOD("demo"),
				"demo/references/test.sh": "#!/bin/sh\necho nope >&2\nexit 3\n",
			},
			["demo/references/test.sh"],
		);
		try {
			expect((await verifySkill(root, "demo")).join("\n")).toContain(
				"test.sh failed",
			);
		} finally {
			rmSync(root, { recursive: true });
		}
	});
	test("docs-only references need no entrypoint", () => {
		const root = skillTree({
			"demo/SKILL.md": GOOD("demo"),
			"demo/references/examples.md": "# examples\n",
		});
		try {
			expect(verifyRefs(join(root, "demo"))).toEqual([]);
		} finally {
			rmSync(root, { recursive: true });
		}
	});
});
