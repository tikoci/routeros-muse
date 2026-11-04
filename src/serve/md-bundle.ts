// T141: the chat markdown renderer ships inside the page. The pinned
// marked + DOMPurify browser bundles and src/serve/md.js are inlined
// into ui.html at boot, so the UI stays one offline document.
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "<!--muse:markdown-->";

// [package, file inside it]; resolved through each package.json
// because marked's exports map does not expose its UMD build.
const SOURCES = [
	["marked", "lib/marked.umd.js"],
	["dompurify", "dist/purify.min.js"],
] as const;

function bundlePath(pkg: string, file: string): string {
	const pj = fileURLToPath(import.meta.resolve(`${pkg}/package.json`));
	return path.join(path.dirname(pj), file);
}

async function scriptTag(file: string): Promise<string> {
	const js = (await Bun.file(file).text()).replace(
		/^\/\/# sourceMappingURL=.*$/m,
		"",
	);
	if (/<\/script/i.test(js)) throw new Error(`${file}: contains </script`);
	return `<script>${js}</script>`;
}

/** The three script tags, in load order. Throws when a bundle is missing. */
export async function markdownScripts(): Promise<string> {
	const files = [
		...SOURCES.map(([pkg, file]) => bundlePath(pkg, file)),
		fileURLToPath(new URL("./md.js", import.meta.url)),
	];
	return (await Promise.all(files.map(scriptTag))).join("\n");
}

/** Replace the page's markdown marker with the inlined scripts. */
export async function inlineMarkdown(html: string): Promise<string> {
	if (!html.includes(MARKER)) throw new Error(`ui.html: missing ${MARKER}`);
	const scripts = await markdownScripts();
	return html.replace(MARKER, () => scripts);
}
