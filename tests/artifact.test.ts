// T83 artifact route tests: resolveArtifact allowlist / traversal /
// symlink escape / size cap, tier CSP headers (pure + live route).
// Hermetic: temp dirs cleaned in afterAll, echo provider, never $HOME.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { have } from "../src/lib/run";
import {
	ARTIFACT_CSP,
	ARTIFACT_MAX_BYTES,
	artifactSecurityHeaders,
	artifactTier,
	isArtifactPath,
	resolveArtifact,
} from "../src/lib/workspace";
import { startServer } from "../src/serve/server";

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) nodeFs.rmSync(d, { recursive: true, force: true });
});

function makeDir(prefix: string): string {
	const d = nodeFs.mkdtempSync(path.join(os.tmpdir(), prefix));
	dirs.push(d);
	return d;
}

function makeWs(): string {
	const ws = makeDir("t83-art-ws-");
	nodeFs.writeFileSync(path.join(ws, "workspace.toml"), "canonical = true\n");
	return ws;
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
		nodeFs.symlinkSync(
			path.join(ws, "realdir"),
			path.join(ws, "linkdir"),
		);
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

	test("render-dir job.json tier scripts promotes the artifact", () => {
		const ws = makeWs();
		expect(artifactTier(ws, renderDir(ws, "scripts"))).toBe("scripts");
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
		"GET /api/artifact serves bytes with tier headers",
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
				const js = await fetch(`${base}&tier=scripts`);
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
