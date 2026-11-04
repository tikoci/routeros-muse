// T141: the one safe markdown renderer, shared by chat (and T142's
// panel view). Browser script, inlined into ui.html at server boot
// after the pinned marked + DOMPurify bundles (no CDN, no network).
//
// Safety order: marked never passes raw HTML (html tokens render as
// escaped text), images render as their alt text (no remote fetches),
// then DOMPurify sanitizes against a fixed tag/attribute allowlist.
// Links are not decided here: every surviving <a> goes to the
// caller's link hook (T109 rules live in ui.html), which returns the
// node to put in its place.
(() => {
	const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
	const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

	const md = new marked.Marked({ gfm: true, breaks: true, async: false });
	md.use({
		renderer: {
			html: (tok) => esc(tok.text),
			image: (tok) => esc(tok.text),
			checkbox: (tok) => (tok.checked ? "☑" : "☐"),
		},
	});

	const TAGS = [
		"p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
		"strong", "em", "del", "code", "pre", "blockquote",
		"ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "a",
	];
	const PURIFY = {
		ALLOWED_TAGS: TAGS,
		ALLOWED_ATTR: ["href", "start", "align"],
		ALLOW_DATA_ATTR: false,
		RETURN_DOM_FRAGMENT: true,
	};

	/**
	 * Render agent markdown into a sanitized fragment.
	 * opts.link(href, label) → Node to replace each anchor with.
	 * opts.text(textNode) → optional hook for text outside links/pre.
	 */
	function render(text, opts = {}) {
		const html = md.parse(String(text ?? ""));
		const frag = DOMPurify.sanitize(html, PURIFY);
		for (const a of Array.from(frag.querySelectorAll("a"))) {
			const label = a.textContent ?? "";
			const node = opts.link
				? opts.link(a.getAttribute("href") ?? "", label)
				: document.createTextNode(label);
			a.replaceWith(node);
		}
		if (opts.text) {
			const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT);
			const nodes = [];
			for (let n = walker.nextNode(); n; n = walker.nextNode()) {
				if (n.parentElement?.closest("a, pre")) continue;
				nodes.push(n);
			}
			for (const n of nodes) opts.text(n);
		}
		return frag;
	}

	globalThis.MuseMd = { render };
})();
