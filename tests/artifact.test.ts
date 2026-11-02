// T83 artifact route tests: resolveArtifact allowlist / traversal /
// symlink escape / size cap, tier CSP headers (pure + live route).
// Hermetic: temp dirs cleaned in afterAll, echo provider, never $HOME.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import {
	canonicalJobPayload,
	ensureRenderKey,
	sha256Hex,
	signJobPayload,
} from "../src/lib/renderSig";
import { have } from "../src/lib/run";
import {
	ARTIFACT_CSP,
	ARTIFACT_MAX_BYTES,
	artifactSecurityHeaders,
	artifactTier,
	isArtifactPath,
	JOB_META_MAX_BYTES,
	listRecents,
	resolveArtifact,
	type TierMemo,
} from "../src/lib/workspace";
import { runRenderJob, runTopology } from "../src/render/jobs";
import { startServer } from "../src/serve/server";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";

const dirs: string[] = [];
afterAll(cleanupTmpdirs);
afterAll(() => {
	for (const d of dirs) nodeFs.rmSync(d, { recursive: true, force: true });
});

function makeDir(prefix: string): string {
	const d = mktmp(prefix);
	dirs.push(d);
	return d;
}

function makeWs(): string {
	const ws = makeDir("t83-art-ws-");
	nodeFs.writeFileSync(path.join(ws, "workspace.toml"), "canonical = true\n");
	return ws;
}

/** Bun's node:fs has no mkfifoSync; the coreutils binary fills in. */
function makeFifo(p: string): void {
	const r = Bun.spawnSync(["mkfifo", p]);
	if (r.exitCode !== 0) throw new Error(`mkfifo ${p} failed`);
}

const STATIC_CSP =
	"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'";
const SCRIPTS_CSP =
	"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'";

describe("artifact allowlist", () => {
	test("isArtifactPath admits the renderable set, case-insensitively", () => {
		for (const ext of [
			"html",
			"htm",
			"svg",
			"png",
			"jpg",
			"jpeg",
			"gif",
			"webp",
		]) {
			expect(isArtifactPath(`reports/x.${ext}`)).toBe(true);
			expect(isArtifactPath(`X.${ext.toUpperCase()}`)).toBe(true);
		}
	});

	test("isArtifactPath rejects source and lookalike names", () => {
		for (const rel of [
			"notes.md",
			"workspace.toml",
			"topology.mmd",
			"topology.dot",
			"topology.txt",
			"noext",
			"x.html.bak",
			"x.png.exe",
			".html",
		]) {
			expect(isArtifactPath(rel)).toBe(false);
		}
	});

	test("resolveArtifact serves allowlisted files anywhere in the workspace", () => {
		const ws = makeWs();
		const rels = ["top.html", "reports/r.htm", "deep/nest/i.svg", "p.png"];
		for (const rel of rels) {
			const full = path.join(ws, rel);
			nodeFs.mkdirSync(path.dirname(full), { recursive: true });
			nodeFs.writeFileSync(full, "<x>ok</x>");
		}
		for (const rel of rels) {
			const r = resolveArtifact(ws, rel);
			expect(r.ok).toBe(true);
		}
	});

	test("resolveArtifact rejects non-artifacts, dirs, and missing files", () => {
		const ws = makeWs();
		nodeFs.writeFileSync(path.join(ws, "notes.md"), "# hi\n");
		nodeFs.mkdirSync(path.join(ws, "reports"), { recursive: true });
		const md = resolveArtifact(ws, "notes.md");
		expect(md.ok).toBe(false);
		if (!md.ok) expect(md.status).toBe(400);
		const dir = resolveArtifact(ws, "reports");
		expect(dir.ok).toBe(false);
		const missing = resolveArtifact(ws, "nope.html");
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.status).toBe(404);
	});

	test("resolveArtifact content types per extension", () => {
		const ws = makeWs();
		const cases: [string, string][] = [
			["a.html", "text/html; charset=utf-8"],
			["a.htm", "text/html; charset=utf-8"],
			["a.svg", "image/svg+xml"],
			["a.png", "image/png"],
			["a.jpg", "image/jpeg"],
			["a.jpeg", "image/jpeg"],
			["a.gif", "image/gif"],
			["a.webp", "image/webp"],
		];
		for (const [rel, want] of cases) {
			nodeFs.writeFileSync(path.join(ws, rel), "x");
			const r = resolveArtifact(ws, rel);
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.contentType).toBe(want);
		}
	});
});

describe("artifact containment", () => {
	test("traversal and absolute paths are refused", () => {
		const ws = makeWs();
		nodeFs.writeFileSync(path.join(ws, "in.html"), "x");
		for (const rel of [
			"../out.html",
			"a/../../out.html",
			"/etc/host.html",
			"sub/../../../etc/x.html",
		]) {
			const r = resolveArtifact(ws, rel);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.status).toBe(400);
		}
	});

	test("a symlink pointing outside the workspace cannot escape", () => {
		const ws = makeWs();
		const outside = makeDir("t83-art-out-");
		nodeFs.writeFileSync(path.join(outside, "secret.html"), "secret");
		nodeFs.symlinkSync(
			path.join(outside, "secret.html"),
			path.join(ws, "link.html"),
		);
		const r = resolveArtifact(ws, "link.html");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.status).toBe(400);
	});

	test("no symlink anywhere in the artifact path, even inside", () => {
		const ws = makeWs();
		nodeFs.writeFileSync(path.join(ws, "real.html"), "real");
		nodeFs.symlinkSync(path.join(ws, "real.html"), path.join(ws, "alias.html"));
		const r = resolveArtifact(ws, "alias.html");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.status).toBe(400);
			expect(r.why).toBe("artifacts may not be symlinks");
		}
	});

	test("a link smuggling a non-artifact name is still a symlink refusal", () => {
		const ws = makeWs();
		nodeFs.writeFileSync(path.join(ws, "device.cdb"), "cdb-bytes");
		nodeFs.symlinkSync(
			path.join(ws, "device.cdb"),
			path.join(ws, "alias.html"),
		);
		const r = resolveArtifact(ws, "alias.html");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.status).toBe(400);
			expect(r.why).toBe("artifacts may not be symlinks");
		}
	});

	test("a file under a symlinked dir is refused", () => {
		const ws = makeWs();
		nodeFs.mkdirSync(path.join(ws, "realdir"), { recursive: true });
		nodeFs.writeFileSync(path.join(ws, "realdir", "r.html"), "real");
		nodeFs.symlinkSync(path.join(ws, "realdir"), path.join(ws, "linkdir"));
		const r = resolveArtifact(ws, "linkdir/r.html");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.status).toBe(400);
			expect(r.why).toBe("artifacts may not be symlinks");
		}
	});
});

describe("artifact size cap", () => {
	test("cap is 8 MiB, separate from the 512 KiB editor cap", () => {
		expect(ARTIFACT_MAX_BYTES).toBe(8 * 1024 * 1024);
		const ws = makeWs();
		// 600 KiB: over the editor cap, under the artifact cap.
		nodeFs.writeFileSync(path.join(ws, "big.html"), "x".repeat(600 * 1024));
		expect(resolveArtifact(ws, "big.html").ok).toBe(true);
	});

	test("files over 8 MiB are refused", () => {
		const ws = makeWs();
		nodeFs.writeFileSync(
			path.join(ws, "huge.html"),
			"x".repeat(ARTIFACT_MAX_BYTES + 1),
		);
		const r = resolveArtifact(ws, "huge.html");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.status).toBe(400);
	});
});

describe("artifact tiers", () => {
	function renderDir(ws: string, tier: unknown): string {
		const dir = path.join(ws, "reports", "render", "topology-stamp");
		nodeFs.mkdirSync(dir, { recursive: true });
		nodeFs.writeFileSync(path.join(dir, "topology.html"), "<html></html>");
		nodeFs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ tier }));
		return "reports/render/topology-stamp/topology.html";
	}

	const TOPO = {
		title: "prov",
		nodes: [{ id: "gw" }, { id: "ap" }],
		links: [{ from: "gw", to: "ap" }],
	};

	test("a forged job.json claims nothing: static, no render-job grant", () => {
		const ws = makeWs();
		const dh = makeDir("t83-prov-dh-");
		// Hand-written metadata, no signature from any render job.
		expect(artifactTier(ws, renderDir(ws, "scripts"), { dataHome: dh })).toBe(
			"static",
		);
	});

	test("a genuine render job verifies into the scripts tier", async () => {
		const ws = makeWs();
		const dh = makeDir("t83-prov-dh-");
		const res = await runTopology(ws, TOPO, "web", dh);
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error("topology job failed");
		expect(artifactTier(ws, `${res.dir}/topology.html`, { dataHome: dh })).toBe(
			"scripts",
		);
	});

	test("editing the HTML after the job revokes the grant", async () => {
		const ws = makeWs();
		const dh = makeDir("t83-prov-dh-");
		const res = await runTopology(ws, TOPO, "web", dh);
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error("topology job failed");
		const rel = `${res.dir}/topology.html`;
		expect(artifactTier(ws, rel, { dataHome: dh })).toBe("scripts");
		nodeFs.appendFileSync(path.join(ws, rel), "<!-- edited -->\n");
		expect(artifactTier(ws, rel, { dataHome: dh })).toBe("static");
	});

	test("a file dropped into a genuine render dir rides no grant", async () => {
		const ws = makeWs();
		const dh = makeDir("t83-prov-dh-");
		const res = await runTopology(ws, TOPO, "web", dh);
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error("topology job failed");
		nodeFs.writeFileSync(
			path.join(ws, res.dir, "evil.html"),
			"<script>location.href='http://example.invalid/'</script>\n",
		);
		expect(artifactTier(ws, `${res.dir}/evil.html`, { dataHome: dh })).toBe(
			"static",
		);
	});

	test("an oversize job.json is ignored, never read", async () => {
		const ws = makeWs();
		const dh = makeDir("t83-prov-dh-");
		const res = await runTopology(ws, TOPO, "web", dh);
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error("topology job failed");
		const rel = `${res.dir}/topology.html`;
		expect(artifactTier(ws, rel, { dataHome: dh })).toBe("scripts");
		// Pad the metadata past the cap without touching the tier
		// claim or the file list: if the lookup read it, the sig
		// would still verify. Static proves the size gate skipped it.
		const jobFile = path.join(ws, res.dir, "job.json");
		const job = JSON.parse(nodeFs.readFileSync(jobFile, "utf8")) as Record<
			string,
			unknown
		>;
		job["pad"] = "x".repeat(JOB_META_MAX_BYTES + 1);
		nodeFs.writeFileSync(jobFile, JSON.stringify(job));
		expect(nodeFs.statSync(jobFile).size).toBeGreaterThan(JOB_META_MAX_BYTES);
		expect(artifactTier(ws, rel, { dataHome: dh })).toBe("static");
	});

	test("one request memoizes one tier per render dir", async () => {
		const ws = makeWs();
		const dh = makeDir("t83-prov-dh-");
		const res = await runRenderJob(
			ws,
			"report",
			{ title: "R", markdown: "# hi" },
			"web",
			dh,
		);
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error("report job failed");
		const cache = new Map<string, TierMemo>();
		const cx = { dataHome: dh, cache };
		expect(artifactTier(ws, `${res.dir}/report.html`, cx)).toBe("static");
		expect(artifactTier(ws, `${res.dir}/report.html`, cx)).toBe("static");
		expect(artifactTier(ws, "reports/stray.html", cx)).toBe("static");
		expect(cache.size).toBe(1);
		expect(cache.get(res.dir)).toEqual({ tier: "static", names: [] });
	});

	test("flipping a genuine job.json tier to scripts grants nothing", async () => {
		const ws = makeWs();
		const dh = makeDir("t83-prov-dh-");
		const res = await runRenderJob(
			ws,
			"report",
			{ title: "R", markdown: "# hi" },
			"web",
			dh,
		);
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error("report job failed");
		const rel = `${res.dir}/report.html`;
		expect(artifactTier(ws, rel, { dataHome: dh })).toBe("static");
		const jobFile = path.join(ws, res.dir, "job.json");
		const job = JSON.parse(nodeFs.readFileSync(jobFile, "utf8")) as Record<
			string,
			unknown
		>;
		job["tier"] = "scripts";
		nodeFs.writeFileSync(jobFile, JSON.stringify(job));
		expect(artifactTier(ws, rel, { dataHome: dh })).toBe("static");
	});

	test("everything else opens static", () => {
		const ws = makeWs();
		expect(artifactTier(ws, renderDir(ws, "static"))).toBe("static");
		expect(artifactTier(ws, renderDir(ws, "evil"))).toBe("static");
		// job.json outside a render dir is not a tier grant.
		nodeFs.mkdirSync(path.join(ws, "reports"), { recursive: true });
		nodeFs.writeFileSync(path.join(ws, "reports", "x.html"), "x");
		nodeFs.writeFileSync(
			path.join(ws, "reports", "job.json"),
			JSON.stringify({ tier: "scripts" }),
		);
		expect(artifactTier(ws, "reports/x.html")).toBe("static");
		// missing or malformed job.json fails closed.
		const dir = path.join(ws, "reports", "render", "bare-stamp");
		nodeFs.mkdirSync(dir, { recursive: true });
		nodeFs.writeFileSync(path.join(dir, "b.html"), "x");
		expect(artifactTier(ws, "reports/render/bare-stamp/b.html")).toBe("static");
		nodeFs.writeFileSync(path.join(dir, "job.json"), "{nope");
		expect(artifactTier(ws, "reports/render/bare-stamp/b.html")).toBe("static");
	});
});

describe("artifact security headers", () => {
	test("shipped CSP strings are exact", () => {
		expect(ARTIFACT_CSP.static).toBe(STATIC_CSP);
		expect(ARTIFACT_CSP.scripts).toBe(SCRIPTS_CSP);
	});

	test("no tier ever grants same-origin or connect", () => {
		for (const csp of Object.values(ARTIFACT_CSP)) {
			expect(csp).not.toContain("allow-same-origin");
			expect(csp).not.toContain("connect-src");
		}
	});

	test("the served frame never allows top navigation, popups, or forms", () => {
		// The iframe sandbox attribute lives in the served UI bytes;
		// pin the invariant there so a UI edit cannot widen it.
		const ui = nodeFs.readFileSync(
			path.join(import.meta.dir, "..", "src", "serve", "ui.html"),
			"utf8",
		);
		for (const token of [
			"allow-top-navigation",
			"allow-popups",
			"allow-forms",
		]) {
			expect(ui).not.toContain(token);
		}
		expect(ui).toContain('sandbox=""');
	});

	test("unknown tiers fail closed to static", () => {
		for (const tier of [null, "", "static", "STATIC", "evil"]) {
			const h = artifactSecurityHeaders(tier);
			expect(h["content-security-policy"]).toBe(STATIC_CSP);
		}
		expect(artifactSecurityHeaders("scripts")["content-security-policy"]).toBe(
			SCRIPTS_CSP,
		);
	});

	test("nosniff and no-store ride every tier", () => {
		for (const tier of ["static", "scripts", null] as const) {
			const h = artifactSecurityHeaders(tier);
			expect(h["x-content-type-options"]).toBe("nosniff");
			expect(h["cache-control"]).toBe("no-store");
		}
	});
});

describe("artifact route", () => {
	const t = have("muse") ? test : test.skip;
	t(
		"GET /api/artifact serves bytes with serve-time headers",
		async () => {
			const ws = makeWs();
			nodeFs.mkdirSync(path.join(ws, "reports"), { recursive: true });
			nodeFs.writeFileSync(
				path.join(ws, "reports", "r.html"),
				"<!doctype html><title>t</title>",
			);
			const srv = await startServer({
				allowOpenCdb: true,
				workspace: ws,
				provider: "echo",
				museHome: makeDir("t83-art-home-"),
				dataHome: makeDir("t83-art-dh-"),
				configHome: makeDir("t83-art-cfg-"),
			});
			try {
				const base = `${srv.url}api/artifact?path=${encodeURIComponent("reports/r.html")}`;
				const res = await fetch(base);
				expect(res.status).toBe(200);
				expect(res.headers.get("content-type")).toContain("text/html");
				expect(res.headers.get("content-security-policy")).toBe(STATIC_CSP);
				expect(res.headers.get("x-content-type-options")).toBe("nosniff");
				expect(res.headers.get("cache-control")).toBe("no-store");
				expect(await res.text()).toContain("<title>t</title>");
				// Client tier names are ignored; only opt-in grants.
				const stale = await fetch(`${base}&tier=scripts`);
				expect(stale.status).toBe(200);
				expect(stale.headers.get("content-security-policy")).toBe(STATIC_CSP);
				const js = await fetch(`${base}&optin=1`);
				expect(js.status).toBe(200);
				expect(js.headers.get("content-security-policy")).toBe(SCRIPTS_CSP);
				const evil = await fetch(`${base}&tier=evil`);
				expect(evil.headers.get("content-security-policy")).toBe(STATIC_CSP);
				const trav = await fetch(
					`${srv.url}api/artifact?path=${encodeURIComponent("../../etc/x.html")}`,
				);
				expect(trav.status).toBe(400);
				const src = await fetch(
					`${srv.url}api/artifact?path=${encodeURIComponent("workspace.toml")}`,
				);
				expect(src.status).toBe(400);
			} finally {
				await srv.stop();
			}
		},
		30_000,
	);
});

describe("serve-time provenance (T83 followup 2)", () => {
	const t = have("muse") ? test : test.skip;
	const TOPO2 = {
		title: "prov2",
		nodes: [{ id: "gw" }, { id: "ap" }],
		links: [{ from: "gw", to: "ap" }],
	};

	async function startWs() {
		const ws = makeWs();
		const dh = makeDir("t83-fu2-dh-");
		const srv = await startServer({
			allowOpenCdb: true,
			workspace: ws,
			provider: "echo",
			museHome: makeDir("t83-fu2-home-"),
			dataHome: dh,
			configHome: makeDir("t83-art-cfg-"),
		});
		return { ws, dh, srv };
	}

	t(
		"reviewer repro: edited bytes opened from a stale tree entry stay static",
		async () => {
			const { ws, dh, srv } = await startWs();
			try {
				const res = await runTopology(ws, TOPO2, "web", dh);
				expect(res.ok).toBe(true);
				if (!res.ok) throw new Error("topology job failed");
				const rel = `${res.dir}/topology.html`;
				// The tree loads while the job is fresh: a scripts hint.
				const tree = (await (await fetch(`${srv.url}api/tree`)).json()) as {
					entries: { path: string; tier?: string }[];
				};
				expect(tree.entries.find((e) => e.path === rel)?.tier).toBe("scripts");
				// Edit after the tree loaded; open from the stale entry,
				// carrying its stale tier. Serve time must refuse it.
				nodeFs.appendFileSync(path.join(ws, rel), "<!-- edited -->\n");
				const art = await fetch(
					`${srv.url}api/artifact?path=${encodeURIComponent(rel)}&tier=scripts`,
				);
				expect(art.status).toBe(200);
				expect(art.headers.get("content-security-policy")).toBe(STATIC_CSP);
				const meta = (await (
					await fetch(
						`${srv.url}api/artifact/meta?path=${encodeURIComponent(rel)}`,
					)
				).json()) as { provenance: string | null };
				expect(meta.provenance).toBeNull();
			} finally {
				await srv.stop();
			}
		},
		30_000,
	);

	t(
		"the route ignores any client tier parameter",
		async () => {
			const { ws, dh, srv } = await startWs();
			try {
				nodeFs.writeFileSync(
					path.join(ws, "plain.html"),
					"<!doctype html><title>p</title>",
				);
				const res = await runTopology(ws, TOPO2, "web", dh);
				expect(res.ok).toBe(true);
				if (!res.ok) throw new Error("topology job failed");
				const job = `${res.dir}/topology.html`;
				const cspOf = async (rel: string, q: string): Promise<string> => {
					const r = await fetch(
						`${srv.url}api/artifact?path=${encodeURIComponent(rel)}${q}`,
					);
					expect(r.status).toBe(200);
					return r.headers.get("content-security-policy") ?? "";
				};
				// A client tier never grants scripts to static bytes.
				expect(await cspOf("plain.html", "&tier=scripts")).toBe(STATIC_CSP);
				expect(await cspOf("plain.html", "&tier=evil")).toBe(STATIC_CSP);
				// ... and never downgrades verified bytes either: the
				// server decides from the buffer it just read.
				expect(await cspOf(job, "")).toBe(SCRIPTS_CSP);
				expect(await cspOf(job, "&tier=static")).toBe(SCRIPTS_CSP);
				expect(await cspOf(job, "&tier=scripts")).toBe(SCRIPTS_CSP);
			} finally {
				await srv.stop();
			}
		},
		30_000,
	);

	t(
		"owner opt-in grants scripts; nothing else does",
		async () => {
			const { ws, dh, srv } = await startWs();
			try {
				nodeFs.writeFileSync(path.join(ws, "plain.html"), "<title>p</title>");
				const res = await runTopology(ws, TOPO2, "web", dh);
				expect(res.ok).toBe(true);
				if (!res.ok) throw new Error("topology job failed");
				const job = `${res.dir}/topology.html`;
				const cspOf = async (rel: string, q: string): Promise<string> => {
					const r = await fetch(
						`${srv.url}api/artifact?path=${encodeURIComponent(rel)}${q}`,
					);
					expect(r.status).toBe(200);
					return r.headers.get("content-security-policy") ?? "";
				};
				expect(await cspOf("plain.html", "&optin=1")).toBe(SCRIPTS_CSP);
				expect(await cspOf("plain.html", "&optin=0")).toBe(STATIC_CSP);
				expect(await cspOf("plain.html", "&optin=yes")).toBe(STATIC_CSP);
				expect(await cspOf("plain.html", "")).toBe(STATIC_CSP);
				// Edited job bytes lose the render grant but keep opt-in.
				nodeFs.appendFileSync(path.join(ws, job), "<!-- edited -->\n");
				expect(await cspOf(job, "")).toBe(STATIC_CSP);
				expect(await cspOf(job, "&optin=1")).toBe(SCRIPTS_CSP);
			} finally {
				await srv.stop();
			}
		},
		30_000,
	);

	t(
		"meta reports fresh provenance",
		async () => {
			const { ws, dh, srv } = await startWs();
			try {
				nodeFs.writeFileSync(path.join(ws, "plain.html"), "<title>p</title>");
				const res = await runTopology(ws, TOPO2, "web", dh);
				expect(res.ok).toBe(true);
				if (!res.ok) throw new Error("topology job failed");
				const job = `${res.dir}/topology.html`;
				const provOf = async (rel: string): Promise<unknown> => {
					const r = await fetch(
						`${srv.url}api/artifact/meta?path=${encodeURIComponent(rel)}`,
					);
					expect(r.status).toBe(200);
					return ((await r.json()) as { provenance: unknown }).provenance;
				};
				expect(await provOf(job)).toBe("render-job");
				nodeFs.appendFileSync(path.join(ws, job), "<!-- edited -->\n");
				expect(await provOf(job)).toBeNull();
				expect(await provOf("plain.html")).toBeNull();
				expect(await provOf("missing.html")).toBeNull();
				expect(await provOf("workspace.toml")).toBeNull();
			} finally {
				await srv.stop();
			}
		},
		30_000,
	);

	t(
		"null-shaped job.json keeps tree and recents at 200",
		async () => {
			const { ws, srv } = await startWs();
			try {
				const raws: unknown[] = [null, [], 5, "x"];
				raws.forEach((raw, i) => {
					const dir = path.join(ws, "reports", "render", `shapejob-${i}`);
					nodeFs.mkdirSync(dir, { recursive: true });
					nodeFs.writeFileSync(path.join(dir, "x.html"), "<title>x</title>");
					nodeFs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(raw));
					nodeFs.writeFileSync(path.join(dir, "job.json.sig"), "0".repeat(64));
				});
				expect((await fetch(`${srv.url}api/tree`)).status).toBe(200);
				expect((await fetch(`${srv.url}api/recents`)).status).toBe(200);
			} finally {
				await srv.stop();
			}
		},
		30_000,
	);

	t(
		"fifo.html serves 400 within the timeout",
		async () => {
			const { ws, srv } = await startWs();
			try {
				makeFifo(path.join(ws, "fifo.html"));
				const r = await fetch(
					`${srv.url}api/artifact?path=${encodeURIComponent("fifo.html")}`,
					{ signal: AbortSignal.timeout(10_000) },
				);
				expect(r.status).toBe(400);
			} finally {
				await srv.stop();
			}
		},
		30_000,
	);

	test("an over-cap member is rejected without trusting its bytes", () => {
		const ws = makeWs();
		const dh = makeDir("t83-fu2-dh-");
		const jobDirRel = "reports/render/big-stamp";
		const dir = path.join(ws, jobDirRel);
		nodeFs.mkdirSync(dir, { recursive: true });
		// Sparse: instant, no disk. The size gate must refuse it
		// before any read — asserted by the size precondition, not
		// timing.
		const member = path.join(dir, "big.html");
		nodeFs.writeFileSync(member, "");
		nodeFs.truncateSync(member, ARTIFACT_MAX_BYTES + 1);
		expect(nodeFs.statSync(member).size).toBeGreaterThan(ARTIFACT_MAX_BYTES);
		nodeFs.writeFileSync(
			path.join(dir, "job.json"),
			JSON.stringify({ tier: "scripts", files: ["big.html"] }),
		);
		const key = ensureRenderKey(dh);
		const sig = signJobPayload(
			key,
			canonicalJobPayload(jobDirRel, "scripts", {
				"big.html": sha256Hex(nodeFs.readFileSync(member)),
			}),
		);
		nodeFs.writeFileSync(path.join(dir, "job.json.sig"), `${sig}\n`);
		expect(artifactTier(ws, `${jobDirRel}/big.html`, { dataHome: dh })).toBe(
			"static",
		);
	});

	test("verification never reads past the 16 MiB total budget", () => {
		// sol re-review 3: three 8 MiB members read all 24 MiB before
		// the total check rejected them. Count real fd reads.
		const ws = makeWs();
		const dh = makeDir("t83-fu3-dh-");
		const jobDirRel = "reports/render/budget-stamp";
		const dir = path.join(ws, jobDirRel);
		nodeFs.mkdirSync(dir, { recursive: true });
		const files = ["a.html", "b.html", "c.html"];
		for (const f of files) {
			const m = path.join(dir, f);
			nodeFs.writeFileSync(m, "");
			nodeFs.truncateSync(m, ARTIFACT_MAX_BYTES);
		}
		nodeFs.writeFileSync(
			path.join(dir, "job.json"),
			JSON.stringify({ tier: "scripts", files }),
		);
		nodeFs.writeFileSync(path.join(dir, "job.json.sig"), "0".repeat(64));
		ensureRenderKey(dh);
		let readBytes = 0;
		const orig = nodeFs.readSync;
		const spy = spyOn(nodeFs, "readSync").mockImplementation(((
			...args: Parameters<typeof nodeFs.readSync>
		) => {
			const n = (orig as (...a: unknown[]) => number)(...args);
			readBytes += n;
			return n;
		}) as typeof nodeFs.readSync);
		try {
			expect(artifactTier(ws, `${jobDirRel}/a.html`, { dataHome: dh })).toBe(
				"static",
			);
		} finally {
			spy.mockRestore();
		}
		expect(readBytes).toBeGreaterThan(0);
		// Members fill the 16 MiB budget exactly (two of three); the
		// rest is job.json/.sig/key metadata, each capped at 64 KiB.
		// Before the fix the third member was read too (24 MiB).
		expect(readBytes).toBeLessThanOrEqual(16 * 1024 * 1024 + 3 * 64 * 1024);
	});

	test("a forged oversized job is rejected by shape before its members", () => {
		const ws = makeWs();
		const dh = makeDir("t83-fu2-dh-");
		const jobDirRel = "reports/render/many-stamp";
		const dir = path.join(ws, jobDirRel);
		nodeFs.mkdirSync(dir, { recursive: true });
		const files = Array.from({ length: 17 }, (_, i) => `m${i}.html`);
		const huge = path.join(dir, "m0.html");
		nodeFs.writeFileSync(huge, "");
		nodeFs.truncateSync(huge, 64 * 1024 * 1024);
		// Precondition, not timing: the member dwarfs the per-verify
		// total (16 MiB), and the file count alone is over the shape
		// cap — so no member is ever read.
		expect(nodeFs.statSync(huge).size).toBeGreaterThan(16 * 1024 * 1024);
		for (const f of files.slice(1))
			nodeFs.writeFileSync(path.join(dir, f), "x");
		nodeFs.writeFileSync(
			path.join(dir, "job.json"),
			JSON.stringify({ tier: "scripts", files }),
		);
		nodeFs.writeFileSync(path.join(dir, "job.json.sig"), "0".repeat(64));
		// A real key on disk: without it the lookup bails before any
		// member read and the no-read property goes unexercised.
		ensureRenderKey(dh);
		expect(artifactTier(ws, `${jobDirRel}/m1.html`, { dataHome: dh })).toBe(
			"static",
		);
	});

	test("seventeen validly-signed members still grant nothing", () => {
		const ws = makeWs();
		const dh = makeDir("t83-fu2-dh-");
		const jobDirRel = "reports/render/cap-stamp";
		const dir = path.join(ws, jobDirRel);
		nodeFs.mkdirSync(dir, { recursive: true });
		const files = Array.from({ length: 17 }, (_, i) => `m${i}.html`);
		const hashes: Record<string, string> = {};
		for (const f of files) {
			nodeFs.writeFileSync(path.join(dir, f), `<title>${f}</title>`);
			hashes[f] = sha256Hex(nodeFs.readFileSync(path.join(dir, f)));
		}
		nodeFs.writeFileSync(
			path.join(dir, "job.json"),
			JSON.stringify({ tier: "scripts", files }),
		);
		const sig = signJobPayload(
			ensureRenderKey(dh),
			canonicalJobPayload(jobDirRel, "scripts", hashes),
		);
		nodeFs.writeFileSync(path.join(dir, "job.json.sig"), `${sig}\n`);
		expect(artifactTier(ws, `${jobDirRel}/m0.html`, { dataHome: dh })).toBe(
			"static",
		);
	});

	test("duplicate or invalid member names grant nothing", () => {
		const cases: { files: unknown[]; setup: string[]; request: string }[] = [
			{ files: ["a.html", "a.html"], setup: ["a.html"], request: "a.html" },
			{ files: ["evil.exe"], setup: ["evil.exe"], request: "evil.exe" },
			{ files: ["noext"], setup: ["noext"], request: "noext" },
			{ files: ["../x.html"], setup: [], request: "x.html" },
			{ files: ["sub/a.html"], setup: ["sub/a.html"], request: "other.html" },
			{ files: ["a.html", 5], setup: ["a.html"], request: "a.html" },
		];
		cases.forEach((c, i) => {
			const ws = makeWs();
			const dh = makeDir("t83-fu2-dh-");
			const jobDirRel = `reports/render/names-${i}`;
			const dir = path.join(ws, jobDirRel);
			nodeFs.mkdirSync(dir, { recursive: true });
			const hashes: Record<string, string> = {};
			for (const f of c.setup) {
				const full = path.join(dir, f);
				nodeFs.mkdirSync(path.dirname(full), { recursive: true });
				nodeFs.writeFileSync(full, "<title>t</title>");
				hashes[f] = sha256Hex(nodeFs.readFileSync(full));
			}
			// Signed with the real key over the hashable members (a
			// zero hash where nothing hashable backs the name): the
			// old code grants the contained cases, the shape gate
			// refuses them all.
			for (const f of c.files) {
				if (typeof f === "string" && hashes[f] === undefined) {
					hashes[f] = "0".repeat(64);
				}
			}
			nodeFs.writeFileSync(
				path.join(dir, "job.json"),
				JSON.stringify({ tier: "scripts", files: c.files }),
			);
			const sig = signJobPayload(
				ensureRenderKey(dh),
				canonicalJobPayload(jobDirRel, "scripts", hashes),
			);
			nodeFs.writeFileSync(path.join(dir, "job.json.sig"), `${sig}\n`);
			expect(
				artifactTier(ws, `${jobDirRel}/${c.request}`, { dataHome: dh }),
				JSON.stringify(c.files),
			).toBe("static");
		});
	});

	test("a FIFO member resolves static promptly", () => {
		const ws = makeWs();
		const dh = makeDir("t83-fu2-dh-");
		const jobDirRel = "reports/render/fifo-stamp";
		const dir = path.join(ws, jobDirRel);
		nodeFs.mkdirSync(dir, { recursive: true });
		makeFifo(path.join(dir, "m.html"));
		nodeFs.writeFileSync(
			path.join(dir, "job.json"),
			JSON.stringify({ tier: "scripts", files: ["m.html"] }),
		);
		nodeFs.writeFileSync(path.join(dir, "job.json.sig"), "0".repeat(64));
		// A real key on disk: without it the lookup bails before
		// the member read and the hang goes unexercised.
		ensureRenderKey(dh);
		expect(artifactTier(ws, `${jobDirRel}/m.html`, { dataHome: dh })).toBe(
			"static",
		);
	}, 10_000);

	test("resolveArtifact refuses FIFOs before opening", () => {
		const ws = makeWs();
		makeFifo(path.join(ws, "fifo.html"));
		const r = resolveArtifact(ws, "fifo.html");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.status).toBe(400);
	});

	test("null-shaped job.json fails closed without throwing", () => {
		const raws: unknown[] = [null, [], 5, "x"];
		raws.forEach((raw, i) => {
			const ws = makeWs();
			const dh = makeDir("t83-fu2-dh-");
			nodeFs.writeFileSync(
				path.join(ws, "workspace.toml"),
				"canonical = true\n",
			);
			const jobDirRel = `reports/render/null-${i}`;
			const dir = path.join(ws, jobDirRel);
			nodeFs.mkdirSync(dir, { recursive: true });
			nodeFs.writeFileSync(path.join(dir, "x.html"), "<title>x</title>");
			nodeFs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(raw));
			nodeFs.writeFileSync(path.join(dir, "job.json.sig"), "0".repeat(64));
			expect(artifactTier(ws, `${jobDirRel}/x.html`, { dataHome: dh })).toBe(
				"static",
			);
			expect(() => listRecents(ws, { dataHome: dh })).not.toThrow();
		});
	});
});

describe("artifact frame pins (T83 followup 2)", () => {
	function uiBytes(): string {
		return nodeFs.readFileSync(
			path.join(import.meta.dir, "..", "src", "serve", "ui.html"),
			"utf8",
		);
	}

	test("the framed CSP strings are pinned in the UI bytes", () => {
		const ui = uiBytes();
		expect(ui).toContain(ARTIFACT_CSP.static);
		expect(ui).toContain(ARTIFACT_CSP.scripts);
	});

	test("the frame carries its tier CSP as its csp attribute", () => {
		expect(uiBytes()).toContain('setAttribute("csp"');
	});

	test("the frame src carries opt-in, never a tier name", () => {
		const ui = uiBytes();
		expect(ui).toContain("optin=1");
		expect(ui).not.toContain("&tier=");
	});
});
