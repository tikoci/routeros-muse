// T141: the shared chat markdown renderer (src/serve/md.js) in a real
// browser, loaded exactly as the server inlines it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Browser, chromium, type Page } from "playwright";
import { inlineMarkdown } from "../src/serve/md-bundle";

let browser: Browser;
let page: Page;

beforeAll(async () => {
	browser = await chromium.launch();
	page = await browser.newPage();
	await page.setContent(
		await inlineMarkdown("<!doctype html><body><!--muse:markdown--></body>"),
	);
	// Real browser launch on a loaded box can exceed bun's 5s hook
	// default (CI run 4: launch starved beside a worker-heavy file).
}, 60_000);

afterAll(async () => {
	// A failed launch must not mask itself behind a close crash.
	if (browser) await browser.close();
});

type El = { tag: string; attrs: string[] };
type Out = { html: string; text: string; hrefs: string[]; els: El[] };

/** Render with a recording link hook that keeps anchors as <a>. */
function render(md: string): Promise<Out> {
	return page.evaluate((src) => {
		const hrefs: string[] = [];
		const box = document.createElement("div");
		box.appendChild(
			(
				globalThis as unknown as {
					MuseMd: {
						render: (
							t: string,
							o: { link: (h: string, l: string) => Node },
						) => DocumentFragment;
					};
				}
			).MuseMd.render(src, {
				link(href, label) {
					hrefs.push(href);
					const a = document.createElement("a");
					a.setAttribute("href", href);
					a.textContent = label;
					return a;
				},
			}),
		);
		const els = [...box.querySelectorAll("*")].map((e) => ({
			tag: e.tagName.toLowerCase(),
			attrs: e.getAttributeNames(),
		}));
		return { html: box.innerHTML, text: box.textContent ?? "", hrefs, els };
	}, md);
}

describe("t141 markdown structure", () => {
	test("headings, emphasis, inline code, lists, fences, tables", async () => {
		const out = await render(
			[
				"## Status",
				"",
				"Router is **up** and `ether1` is *fine*.",
				"",
				"- one",
				"- two",
				"  1. nested",
				"",
				"```routeros",
				"/ip address print",
				"```",
				"",
				"| port | state |",
				"|---|--:|",
				"| ether1 | up |",
			].join("\n"),
		);
		expect(out.html).toContain("<h2>Status</h2>");
		expect(out.html).toContain("<strong>up</strong>");
		expect(out.html).toContain("<em>fine</em>");
		expect(out.html).toContain("<code>ether1</code>");
		expect(out.html).toMatch(/<ul>[\s\S]*<ol>[\s\S]*nested/);
		expect(out.html).toContain("<pre><code>/ip address print\n</code></pre>");
		expect(out.html).toContain("<table>");
		expect(out.html).toContain('<td align="right">up</td>');
	});

	test("single newlines are line breaks (chat, not prose reflow)", async () => {
		const out = await render("line one\nline two");
		expect(out.html).toContain("line one<br>line two");
	});

	test("task list checkboxes render as text, never inputs", async () => {
		const out = await render("- [x] done\n- [ ] todo");
		expect(out.html).not.toContain("<input");
		expect(out.text).toContain("☑ done");
		expect(out.text).toContain("☐ todo");
	});

	test("links go to the hook with their destination", async () => {
		const out = await render("see [notes](notes.md) and <https://x.test/a>");
		expect(out.hrefs).toEqual(["notes.md", "https://x.test/a"]);
	});

	test("without a link hook anchors collapse to their label", async () => {
		const html = await page.evaluate(() => {
			const box = document.createElement("div");
			box.appendChild(
				(
					globalThis as unknown as {
						MuseMd: { render: (t: string) => DocumentFragment };
					}
				).MuseMd.render("[label](notes.md)"),
			);
			return box.innerHTML;
		});
		expect(html.trim()).toBe("<p>label</p>");
	});
});

describe("t141 markdown XSS", () => {
	const ALLOWED =
		/^(p|br|hr|h[1-6]|strong|em|del|code|pre|blockquote|ul|ol|li|table|thead|tbody|tr|th|td|a)$/;

	async function assertInert(md: string): Promise<Out> {
		const out = await render(md);
		for (const e of out.els) {
			expect(e.tag).toMatch(ALLOWED);
			// Only the hook's own href and marked's alignment/start attrs.
			for (const a of e.attrs) expect(a).toMatch(/^(href|align|start)$/);
		}
		for (const h of out.hrefs)
			expect(h).not.toMatch(/^\s*(javascript|data|vbscript):/i);
		return out;
	}

	test("script tags render as text", async () => {
		const out = await assertInert("hi <script>alert(1)</script> there");
		expect(out.text).toContain("<script>alert(1)</script>");
	});

	test("block raw HTML renders as text", async () => {
		const out = await assertInert('<div onclick="alert(1)">\n<b>x</b>\n</div>');
		expect(out.text).toContain('<div onclick="alert(1)">');
	});

	test("img onerror and images never load", async () => {
		await assertInert('<img src=x onerror="alert(1)">');
		const out = await assertInert("![alt text](https://evil.test/p.png)");
		expect(out.text.trim()).toBe("alt text");
	});

	test("javascript:, data: and vbscript: links never reach the hook", async () => {
		await assertInert("[a](javascript:alert(1))");
		await assertInert("[b](JaVaScRiPt:alert(1))");
		await assertInert("[c](data:text/html,<script>alert(1)</script>)");
		await assertInert("[d](vbscript:msgbox)");
		await assertInert("<javascript:alert(1)>");
	});

	test("attribute injection through destinations or titles stays inert", async () => {
		await assertInert('[x](notes.md "t\\" onmouseover=\\"alert(1))');
		await assertInert('[x](notes.md"onmouseover="alert(1))');
		await assertInert("[x](<notes.md onmouseover=alert(1)>)");
	});

	test("raw anchors and iframes in markdown stay text", async () => {
		const out = await assertInert(
			'<a href="javascript:alert(1)">click</a> <iframe src="https://evil.test"></iframe>',
		);
		expect(out.hrefs).toEqual([]);
		expect(out.text).toContain("<iframe");
	});

	test("code spans and fences keep markup as text", async () => {
		const out = await assertInert(
			"`<img src=x onerror=alert(1)>`\n\n```\n<script>alert(2)</script>\n```",
		);
		expect(out.text).toContain("<img src=x onerror=alert(1)>");
		expect(out.text).toContain("<script>alert(2)</script>");
	});
});
