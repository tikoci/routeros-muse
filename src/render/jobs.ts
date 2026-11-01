// Render services (T33): named backend jobs for the agent's non-text
// path. Every job drops artifacts into the shared workspace
// (<root>/reports/render/<job>-<stamp>/) carrying source plus time,
// so the middle tab (or any later UI) renders files, never streams.
//
// D21: topology splits by context — mermaid on web, graphviz DOT on
// CLI, text fallback when graphviz is absent.

import * as nodeFs from "node:fs";
import * as path from "node:path";
import { have, run } from "../lib/run";

export type RenderContext = "web" | "cli";

export type JobResult =
	| { ok: true; job: string; dir: string; files: string[] }
	| { ok: false; job: string; why: string };

export type TopologyNode = { id: string; label?: string; kind?: string };
export type TopologyLink = { from: string; to: string; label?: string };
export type TopologyInput = {
	title?: string;
	nodes: TopologyNode[];
	links: TopologyLink[];
};

export type ReportInput = { title: string; markdown: string };

function stamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function jobDir(root: string, job: string): string {
	const dir = path.join(root, "reports", "render", `${job}-${stamp()}`);
	nodeFs.mkdirSync(dir, { recursive: true });
	return dir;
}

function finishJob(
	root: string,
	job: string,
	dir: string,
	files: string[],
	source: string,
): JobResult {
	nodeFs.writeFileSync(
		path.join(dir, "job.json"),
		`${JSON.stringify(
			{ job, time: new Date().toISOString(), source, files, workspace: root },
			null,
			2,
		)}\n`,
	);
	return {
		ok: true,
		job,
		dir: path.relative(root, dir),
		files: [...files, "job.json"],
	};
}

function safeId(id: string): string {
	const s = id.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 60);
	return s || "n";
}

function escHtml(s: string): string {
	const ENTITIES: Record<string, string> = {
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
	};
	return s.replace(/[&<>"]/g, (c) => ENTITIES[c] ?? c);
}

/** Mermaid flowchart source for the input graph. */
export function topologyMermaid(input: TopologyInput): string {
	const lines = ["flowchart LR"];
	const seen = new Set<string>();
	for (const n of input.nodes) {
		const id = safeId(n.id);
		if (seen.has(id)) continue;
		seen.add(id);
		const label = (n.label ?? n.id).replace(/["#]/g, "");
		lines.push(`    ${id}["${label}"]`);
	}
	for (const l of input.links) {
		const text = l.label ? `|${l.label.replace(/[|]/g, "")}|` : "";
		lines.push(`    ${safeId(l.from)} -->${text} ${safeId(l.to)}`);
	}
	return `${lines.join("\n")}\n`;
}

/** Graphviz DOT source for the input graph. */
export function topologyDot(input: TopologyInput): string {
	const lines = [
		"digraph topology {",
		'    rankdir="LR";',
		"    node [shape=box];",
	];
	const seen = new Set<string>();
	for (const n of input.nodes) {
		const id = safeId(n.id);
		if (seen.has(id)) continue;
		seen.add(id);
		const label = (n.label ?? n.id).replace(/"/g, "");
		lines.push(`    ${id} [label="${label}"];`);
	}
	for (const l of input.links) {
		const attrs = l.label ? ` [label="${l.label.replace(/"/g, "")}"]` : "";
		lines.push(`    ${safeId(l.from)} -> ${safeId(l.to)}${attrs};`);
	}
	lines.push("}");
	return `${lines.join("\n")}\n`;
}

/** Plain-text adjacency fallback (no renderer available). */
export function topologyText(input: TopologyInput): string {
	const lines = [input.title ?? "topology", ""];
	for (const l of input.links) {
		lines.push(`${l.from} -> ${l.to}${l.label ? ` (${l.label})` : ""}`);
	}
	if (input.links.length === 0) {
		for (const n of input.nodes) lines.push(`- ${n.label ?? n.id}`);
	}
	return `${lines.join("\n")}\n`;
}

function mermaidPage(title: string, mmd: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<style>body{background:#0b0e13;color:#e9edf3;font:13px/1.5 system-ui,sans-serif;margin:0;padding:20px}
pre.src{background:#070a0f;border:1px solid #222c3a;border-radius:8px;padding:12px;overflow:auto}
.mermaid{background:#fff;border-radius:8px;padding:16px;margin-bottom:16px}</style>
</head><body>
<h1>${escHtml(title)}</h1>
<div class="mermaid">
${escHtml(mmd)}</div>
<details><summary>source (.mmd — shown when mermaid.js cannot load)</summary>
<pre class="src">${escHtml(mmd)}</pre></details>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script>try{mermaid.initialize({startOnLoad:true});}catch(e){}</script>
</body></html>
`;
}

/** Minimal markdown → HTML (headings, fences, lists, paragraphs, inline). */
export function markdownHtml(title: string, markdown: string): string {
	const inline = (s: string): string =>
		escHtml(s)
			.replace(/`([^`]+)`/g, "<code>$1</code>")
			.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	const out: string[] = [];
	const lines = markdown.split("\n");
	let i = 0;
	let inList = false;
	const closeList = () => {
		if (inList) {
			out.push("</ul>");
			inList = false;
		}
	};
	while (i < lines.length) {
		const line = lines[i];
		if (line === undefined) break;
		const fence = line.match(/^```(\w*)\s*$/);
		if (fence) {
			closeList();
			const buf: string[] = [];
			i++;
			for (;;) {
				const fenced = lines[i];
				if (fenced === undefined || fenced.startsWith("```")) break;
				buf.push(fenced);
				i++;
			}
			i++;
			out.push(`<pre><code>${escHtml(buf.join("\n"))}</code></pre>`);
			continue;
		}
		const h = line.match(/^(#{1,4})\s+(.+)$/);
		if (h) {
			closeList();
			const hashes = h[1] ?? "";
			const text = h[2] ?? "";
			out.push(`<h${hashes.length}>${inline(text)}</h${hashes.length}>`);
			i++;
			continue;
		}
		const li = line.match(/^[-*]\s+(.+)$/);
		if (li) {
			if (!inList) {
				out.push("<ul>");
				inList = true;
			}
			out.push(`<li>${inline(li[1] ?? "")}</li>`);
			i++;
			continue;
		}
		if (line.trim() === "") {
			closeList();
			i++;
			continue;
		}
		closeList();
		out.push(`<p>${inline(line)}</p>`);
		i++;
	}
	closeList();
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<style>body{background:#fff;color:#10151c;font:14px/1.6 system-ui,sans-serif;margin:0 auto;padding:24px;max-width:760px}
pre{background:#10151c;color:#bcd3ff;padding:12px;border-radius:8px;overflow:auto}
code{font:12.5px ui-monospace,monospace}h1{font-size:20px}</style>
</head><body>
<h1>${escHtml(title)}</h1>
${out.join("\n")}
</body></html>
`;
}

function validTopology(input: unknown): input is TopologyInput {
	if (!input || typeof input !== "object") return false;
	const v = input as Record<string, unknown>;
	return Array.isArray(v["nodes"]) && Array.isArray(v["links"]);
}

/** Topology job: web → mermaid (.mmd + .html); cli → DOT (+ .svg or .txt). */
export async function runTopology(
	root: string,
	input: TopologyInput,
	ctx: RenderContext,
): Promise<JobResult> {
	if (!validTopology(input))
		return { ok: false, job: "topology", why: "need {nodes[], links[]}" };
	const dir = jobDir(root, "topology");
	const title = input.title ?? "topology";
	const mmd = topologyMermaid(input);
	const dot = topologyDot(input);
	const files: string[] = [];
	const write = (name: string, text: string) => {
		nodeFs.writeFileSync(path.join(dir, name), text);
		files.push(name);
	};
	write("topology.mmd", mmd);
	write("topology.dot", dot);
	if (ctx === "web") {
		write("topology.html", mermaidPage(title, mmd));
		return finishJob(root, "topology", dir, files, "topology.mmd");
	}
	if (have("dot")) {
		const r = await run(["dot", "-Tsvg", path.join(dir, "topology.dot")], {
			timeoutMs: 30_000,
		});
		if (r.ok && r.stdout.includes("<svg")) {
			write("topology.svg", r.stdout);
			return finishJob(root, "topology", dir, files, "topology.dot");
		}
	}
	write("topology.txt", topologyText(input));
	return finishJob(root, "topology", dir, files, "topology.dot");
}

/** Report job: markdown → self-contained HTML (+ .md source). */
export async function runReport(
	root: string,
	input: ReportInput,
): Promise<JobResult> {
	if (
		!input ||
		typeof input.title !== "string" ||
		typeof input.markdown !== "string"
	) {
		return { ok: false, job: "report", why: "need {title, markdown}" };
	}
	const dir = jobDir(root, "report");
	const files: string[] = [];
	nodeFs.writeFileSync(path.join(dir, "report.md"), input.markdown);
	files.push("report.md");
	nodeFs.writeFileSync(
		path.join(dir, "report.html"),
		markdownHtml(input.title, input.markdown),
	);
	files.push("report.html");
	return finishJob(root, "report", dir, files, "report.md");
}

export type MapInput = {
	title?: string;
	markers: { label: string; note?: string }[];
};
export type ChartInput = {
	title: string;
	series: { label: string; value: number }[];
};

/** Map/chart jobs: contracts defined, renderers follow when a UI seam needs them. */
export async function runMap(
	_root: string,
	_input: MapInput,
): Promise<JobResult> {
	return {
		ok: false,
		job: "map",
		why: "map renderer is not built yet (T33 follow-up: needs a tile/offline decision)",
	};
}

export async function runChart(
	_root: string,
	_input: ChartInput,
): Promise<JobResult> {
	return {
		ok: false,
		job: "chart",
		why: "chart renderer is not built yet (T33 follow-up: needs a no-dependency SVG chart choice)",
	};
}

export type JobName = "topology" | "report" | "map" | "chart";

/** Dispatch by job name; unknown names fail closed. */
export async function runRenderJob(
	root: string,
	job: string,
	input: unknown,
	ctx: RenderContext,
): Promise<JobResult> {
	if (job === "topology") return runTopology(root, input as TopologyInput, ctx);
	if (job === "report") return runReport(root, input as ReportInput);
	if (job === "map") return runMap(root, input as MapInput);
	if (job === "chart") return runChart(root, input as ChartInput);
	return {
		ok: false,
		job,
		why: `unknown job (want topology|report|map|chart)`,
	};
}
