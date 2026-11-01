// Render service tests (T33, D21). Pure job tests need no muse;
// the /api/render route test reuses the echo server harness.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { have } from "../src/lib/run";
import { artifactTier, listRecents, type TierMemo } from "../src/lib/workspace";
import {
	markdownHtml,
	runRenderJob,
	runTopology,
	topologyDot,
	topologyHtmlOrThrow,
	topologyMermaid,
	topologyText,
} from "../src/render/jobs";
import { startServer } from "../src/serve/server";

const TOPO = {
	title: "lab",
	nodes: [
		{ id: "gw", label: "gateway" },
		{ id: "ap", label: "shop ap" },
	],
	links: [{ from: "gw", to: "ap", label: "uplink" }],
};

function makeRoot(): string {
	return nodeFs.mkdtempSync(path.join(os.tmpdir(), "t33-render-"));
}

// Provenance-key homes for the job tests: each job signs with its
// own key, never the real data home. Cleaned after the file.
const dhDirs: string[] = [];
afterAll(() => {
	for (const d of dhDirs) nodeFs.rmSync(d, { recursive: true, force: true });
});

function makeDataHome(): string {
	const d = nodeFs.mkdtempSync(path.join(os.tmpdir(), "t33-render-dh-"));
	dhDirs.push(d);
	return d;
}

describe("topology sources", () => {
	test("mermaid flowchart names every node and link", () => {
		const mmd = topologyMermaid(TOPO);
		expect(mmd).toContain("flowchart LR");
		expect(mmd).toContain('gw["gateway"]');
		expect(mmd).toContain("gw -->|uplink| ap");
	});

	test("DOT names every node and link", () => {
		const dot = topologyDot(TOPO);
		expect(dot).toContain("digraph topology");
		expect(dot).toContain('gw [label="gateway"]');
		expect(dot).toContain("gw -> ap");
	});

	test("text fallback lists adjacency", () => {
		expect(topologyText(TOPO)).toContain("gw -> ap (uplink)");
	});
});

describe("render jobs", () => {
	test("web context emits mmd + html + source-time record", async () => {
		const root = makeRoot();
		const res = await runTopology(root, TOPO, "web", makeDataHome());
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error("topology job failed");
		expect(res.files).toContain("topology.mmd");
		expect(res.files).toContain("topology.html");
		const job = JSON.parse(
			nodeFs.readFileSync(path.join(root, res.dir, "job.json"), "utf8"),
		) as Record<string, unknown>;
		expect(job["source"]).toBe("topology.mmd");
		expect(typeof job["time"]).toBe("string");
		const html = nodeFs.readFileSync(
			path.join(root, res.dir, "topology.html"),
			"utf8",
		);
		expect(html).toContain("mermaid");
		expect(html).toContain("gateway");
	});

	test("topology html is offline: inlined mermaid, no external script", async () => {
		const root = makeRoot();
		const res = await runTopology(root, TOPO, "web", makeDataHome());
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error("topology job failed");
		const html = nodeFs.readFileSync(
			path.join(root, res.dir, "topology.html"),
			"utf8",
		);
		expect(html).not.toContain('src="http');
		expect(html).not.toContain("src='http");
		expect(html).toContain("mermaid.initialize");
		// the browser bundle rides inside the file, not the network.
		expect(html.length).toBeGreaterThan(1_000_000);
	});

	test("job.json carries the sandbox tier: topology scripts, report static", async () => {
		const root = makeRoot();
		const topo = await runTopology(root, TOPO, "web", makeDataHome());
		expect(topo.ok).toBe(true);
		if (!topo.ok) throw new Error("topology job failed");
		const topoJob = JSON.parse(
			nodeFs.readFileSync(path.join(root, topo.dir, "job.json"), "utf8"),
		) as Record<string, unknown>;
		expect(topoJob["tier"]).toBe("scripts");
		const rep = await runRenderJob(
			root,
			"report",
			{ title: "R", markdown: "# hi" },
			"web",
			makeDataHome(),
		);
		expect(rep.ok).toBe(true);
		if (!rep.ok) throw new Error("report job failed");
		const repJob = JSON.parse(
			nodeFs.readFileSync(path.join(root, rep.dir, "job.json"), "utf8"),
		) as Record<string, unknown>;
		expect(repJob["tier"]).toBe("static");
	});

	test("jobs sign job.json.sig with a 0600 key beside the registry home", async () => {
		const root = makeRoot();
		try {
			const dh = makeDataHome();
			const rep = await runRenderJob(
				root,
				"report",
				{ title: "R", markdown: "# hi" },
				"web",
				dh,
			);
			expect(rep.ok).toBe(true);
			if (!rep.ok) throw new Error("report job failed");
			const sig = nodeFs
				.readFileSync(path.join(root, rep.dir, "job.json.sig"), "utf8")
				.trim();
			expect(sig).toMatch(/^[0-9a-f]{64}$/);
			const mode = nodeFs.statSync(
				path.join(dh, "routeros-muse", "render.key"),
			).mode;
			expect(mode & 0o077).toBe(0);
		} finally {
			nodeFs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("a missing mermaid bundle fails the job honestly", () => {
		expect(() => topologyHtmlOrThrow("t", "flowchart LR\n", null)).toThrow(
			/mermaid browser bundle/,
		);
		const html = topologyHtmlOrThrow("t", "flowchart LR\n", "/*bundle*/");
		expect(html).toContain("/*bundle*/");
		expect(html).not.toContain('src="http');
	});

	test("cli context emits dot plus svg-or-text", async () => {
		const root = makeRoot();
		const res = await runTopology(root, TOPO, "cli", makeDataHome());
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error("topology job failed");
		expect(res.files).toContain("topology.dot");
		const hasSvg = res.files.includes("topology.svg");
		const hasTxt = res.files.includes("topology.txt");
		expect(hasSvg || hasTxt).toBe(true);
		if (hasSvg) {
			const svg = nodeFs.readFileSync(
				path.join(root, res.dir, "topology.svg"),
				"utf8",
			);
			expect(svg).toContain("<svg");
		}
	});

	test("report escapes markup and keeps structure", async () => {
		const html = markdownHtml(
			"T",
			"# H\n\npara with <script>alert(1)</script>\n\n- a\n- b\n\n```js\nx=1\n```\n",
		);
		expect(html).toContain("<h1>H</h1>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>alert");
		expect(html).toContain("<li>a</li>");
		expect(html).toContain("<pre><code>x=1</code></pre>");
		const root = makeRoot();
		const res = await runRenderJob(
			root,
			"report",
			{ title: "R", markdown: "# hi" },
			"web",
			makeDataHome(),
		);
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error("report job failed");
		expect(res.files).toContain("report.html");
	});

	test("map/chart fail honest; unknown jobs fail closed", async () => {
		const root = makeRoot();
		const m = await runRenderJob(root, "map", { markers: [] }, "web");
		expect(m.ok).toBe(false);
		if (m.ok) throw new Error("map job unexpectedly built");
		expect(m.why).toContain("not built yet");
		const c = await runRenderJob(
			root,
			"chart",
			{ title: "t", series: [] },
			"web",
		);
		expect(c.ok).toBe(false);
		const u = await runRenderJob(root, "video", {}, "web");
		expect(u.ok).toBe(false);
		if (u.ok) throw new Error("unknown job unexpectedly built");
		expect(u.why).toContain("unknown job");
	});

	test("bad topology input is rejected", async () => {
		const root = makeRoot();
		const res = await runRenderJob(root, "topology", { nodes: [] }, "web");
		expect(res.ok).toBe(false);
	});

	test("job.json signs artifact members only", async () => {
		const root = makeRoot();
		try {
			const dh = makeDataHome();
			const topo = await runTopology(root, TOPO, "web", dh);
			expect(topo.ok).toBe(true);
			if (!topo.ok) throw new Error("topology job failed");
			const tj = JSON.parse(
				nodeFs.readFileSync(path.join(root, topo.dir, "job.json"), "utf8"),
			) as Record<string, unknown>;
			expect(tj["files"]).toEqual(["topology.html"]);
			const rep = await runRenderJob(
				root,
				"report",
				{ title: "R", markdown: "# hi" },
				"web",
				dh,
			);
			expect(rep.ok).toBe(true);
			if (!rep.ok) throw new Error("report job failed");
			const rj = JSON.parse(
				nodeFs.readFileSync(path.join(root, rep.dir, "job.json"), "utf8"),
			) as Record<string, unknown>;
			expect(rj["files"]).toEqual(["report.html"]);
		} finally {
			nodeFs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("an unwritable data home still writes outputs, unsigned, with a warning", async () => {
		const root = makeRoot();
		try {
			// A file where the key dir should be: mkdir fails however
			// privileged the runner is.
			const dhFile = path.join(root, "not-a-dir");
			nodeFs.writeFileSync(dhFile, "x");
			const res = await runTopology(root, TOPO, "web", dhFile);
			expect(res.ok).toBe(true);
			if (!res.ok) throw new Error(`job failed: ${res.why}`);
			expect(res.warning).toMatch(/^provenance unavailable: /);
			expect(nodeFs.existsSync(path.join(root, res.dir, "topology.html"))).toBe(
				true,
			);
			expect(nodeFs.existsSync(path.join(root, res.dir, "job.json.sig"))).toBe(
				false,
			);
			expect(
				artifactTier(root, `${res.dir}/topology.html`, { dataHome: dhFile }),
			).toBe("static");
		} finally {
			nodeFs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("after running a job, recents lists its primary artifact", async () => {
		const root = makeRoot();
		try {
			const dh = makeDataHome();
			nodeFs.writeFileSync(
				path.join(root, "workspace.toml"),
				"canonical = true\n",
			);
			const res = await runTopology(root, TOPO, "web", dh);
			expect(res.ok).toBe(true);
			if (!res.ok) throw new Error("topology job failed");
			const rows = listRecents(root, {
				dataHome: dh,
				cache: new Map<string, TierMemo>(),
			});
			const hit = rows.find((r) => r.path === `${res.dir}/topology.html`);
			expect(hit).toBeDefined();
			expect(hit?.kind).toBe("artifact");
			expect(hit?.tier).toBe("scripts");
		} finally {
			nodeFs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("render routes", () => {
	const t = have("muse") ? test : test.skip;
	t(
		"POST /api/render then GET /api/artifact",
		async () => {
			const ws = nodeFs.mkdtempSync(path.join(os.tmpdir(), "t33-serve-ws-"));
			nodeFs.writeFileSync(
				path.join(ws, "workspace.toml"),
				"canonical = true\n",
			);
			const home = nodeFs.mkdtempSync(
				path.join(os.tmpdir(), "t33-serve-home-"),
			);
			const srv = await startServer({
				allowOpenCdb: true,
				workspace: ws,
				provider: "echo",
				museHome: home,
				dataHome: nodeFs.mkdtempSync(path.join(os.tmpdir(), "t33-serve-dh-")),
			});
			try {
				const r = (await (
					await fetch(`${srv.url}api/render`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ job: "topology", input: TOPO }),
					})
				).json()) as { ok: boolean; dir: string; files: string[] };
				expect(r.ok).toBe(true);
				const art = await fetch(
					`${srv.url}api/artifact?path=${encodeURIComponent(`${r.dir}/topology.html`)}`,
				);
				expect(art.status).toBe(200);
				expect(await art.text()).toContain("mermaid.initialize");
				// T83: source files are not renderable artifacts.
				const src = await fetch(
					`${srv.url}api/artifact?path=${encodeURIComponent(`${r.dir}/topology.mmd`)}`,
				);
				expect(src.status).toBe(400);
				const outside = await fetch(
					`${srv.url}api/artifact?path=${encodeURIComponent("workspace.toml")}`,
				);
				expect(outside.status).toBe(400);
			} finally {
				await srv.stop();
			}
		},
		30_000,
	);
});
