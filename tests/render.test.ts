// Render service tests (T33, D21). Pure job tests need no muse;
// the /api/render route test reuses the echo server harness.
import { describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { have } from "../src/lib/run";
import {
	markdownHtml,
	runRenderJob,
	runTopology,
	topologyDot,
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
		const res = await runTopology(root, TOPO, "web");
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

	test("cli context emits dot plus svg-or-text", async () => {
		const root = makeRoot();
		const res = await runTopology(root, TOPO, "cli");
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
					`${srv.url}api/artifact?path=${encodeURIComponent(`${r.dir}/topology.mmd`)}`,
				);
				expect(art.status).toBe(200);
				expect(await art.text()).toContain("flowchart LR");
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
