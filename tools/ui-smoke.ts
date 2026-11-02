// T43 browser smoke: hermetic UI confirmation for UI slices.
//
// Temp workspace + temp muse home + echo provider; starts the real server
// in-process, drives the real page with playwright, and asserts load,
// console cleanliness, a real chat roundtrip, card rendering, the
// open-in-tab wiring, the T39 lock/unlock/bypass flow, the T64
// missing-CDB guidance, the no-workspace mode, the T40
// no-workspace picker (list/open/prune/create), the T48
// set-credentials modal (affordance, context, save, refresh), the
// T71 stop lifecycle (Stopping ticker, Force stop, SIGTERM note), and
// the T50 approval/question surface (cards, waiting strip, selector,
// settings default, late join — all on the scriptable T50 fake),
// and the T49 trust row (on/off/no-workspace) plus device targeting
// (pill targets become chips; the preamble lands in the turn input).
// Screenshots land in out/ui-smoke/ for eyeballing.
// The auth legs need centrs on PATH (fail-loud, never skip: an
// unverified gate is not a green result).
//
// Usage: bun tools/ui-smoke.ts
// Standing rule: every UI slice extends this and runs it before done.
import * as childProcess from "node:child_process";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type Page, type Request } from "playwright";
import { registerWorkspace, registryFile } from "../src/lib/registry";
import { startServer } from "../src/serve/server";
import { cleanupTmpdirs, mktmp } from "../tests/helpers/tmp";
import { stubT50Bin, withT50Env } from "../tests/t50-fake";
import { pollT71Log, stubT71Bin, withT71Env } from "../tests/t71-fake";

type SmokeHook = {
	renderRow: (row: unknown) => HTMLElement;
	renderPatch: (host: HTMLElement, doc: unknown) => void;
	renderOutput: (host: HTMLElement, body: unknown) => void;
	pushImage: (img: { base64Data: string; mediaType: string }) => void;
	recoverPending: () => Promise<void>;
};

declare global {
	interface Window {
		__smoke?: SmokeHook;
	}
}

const HERE = import.meta.dir;
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(ROOT, "out", "ui-smoke");

function makeWorkspace(): string {
	const dir = mktmp("ui-smoke-ws-");
	nodeFs.writeFileSync(
		path.join(dir, "workspace.toml"),
		'[home]\ntype = "private-git"\nrepo = "https://example.invalid/you/net.git"\ncanonical = true\n',
	);
	nodeFs.writeFileSync(path.join(dir, "AGENTS.md"), "# smoke workspace\n");
	nodeFs.writeFileSync(
		path.join(dir, "router.toml"),
		'[device]\nid = "smoke-gw"\nrole = "gateway"\ncdb = "smoke-cdb"\n',
	);
	nodeFs.mkdirSync(path.join(dir, "operations"), { recursive: true });
	nodeFs.writeFileSync(path.join(dir, "operations", "drift.md"), "# drift\n");
	nodeFs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
	// T46: one real doctor alert so the alerts pane renders a true card.
	const smokeOs = os.platform() === "darwin" ? "mac" : "linux";
	nodeFs.writeFileSync(
		path.join(dir, "doctor.local.toml"),
		`[[tool]]\nid = "smoke-bogus"\nos = "${smokeOs}"\ntier = "required"\n` +
			'detect = "command -v definitely-not-a-real-tool-xyz"\n' +
			'hint = "install the bogus tool"\nwhy = "proves the alerts branch"\n',
	);
	return dir;
}

function makeHome(): string {
	const home = mktmp("ui-smoke-home-");
	const dir = path.join(home, "muse", "model-catalog");
	nodeFs.mkdirSync(dir, { recursive: true });
	const fixture = path.join(ROOT, "tests", "fixtures", "model-catalog");
	for (const f of nodeFs.readdirSync(fixture)) {
		nodeFs.copyFileSync(path.join(fixture, f), path.join(dir, f));
	}
	return home;
}

// T71 stop legs: an interruptible turn (Stop → Stopping ticker →
// cleared, no Force) and a stuck turn (ticker → Force stop → SIGTERM
// note), both on fixture-controlled fake workers. Screenshots 18-21.
// T40 hermeticity: smoke boots share one temp data home (the picker
// leg below uses its own), never the developer's real registry.
const SMOKE_DATA_HOME = mktmp("ui-smoke-dh-");

const failures: string[] = [];
function check(name: string, cond: boolean, extra = ""): void {
	console.log(
		`${cond ? "PASS" : "FAIL"}  ${name}${extra && !cond ? ` — ${extra}` : ""}`,
	);
	if (!cond) failures.push(name);
}

// enterApp fires one MSP batch (models/past/history); the short auth
// legs must await it before stopping the server, or teardown rejects
// the in-flight calls and the console fills with 500s (the T39 flake,
// now deterministic under load). Attach all three waiters up front —
// a waiter attached after its response arrived would time out.
function watchAppBatch(page: Page): Promise<unknown[]> {
	return Promise.all(
		["/api/chat/models", "/api/past", "/api/chat/history"].map((p) =>
			page.waitForResponse((r) => new URL(r.url()).pathname === p, {
				timeout: 30_000,
			}),
		),
	);
}

const srv = await startServer({
	dataHome: SMOKE_DATA_HOME,
	allowOpenCdb: true,
	workspace: makeWorkspace(),
	provider: "echo",
	museHome: makeHome(),
});
nodeFs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const consoleErrors: string[] = [];
// T83: sandboxed artifact frames report their own script blocks; the
// frame URL separates those expected notices from real errors below.
// (Probed: a failed subframe navigation commits an error page —
// which is what the UI's load counter catches — with no console
// error of its own, so the nav leg asserts the notice + blank frame
// and the escape attempt on the route, not a console text.)
const artifactBlocks: string[] = [];
const artifactBlockUrls: string[] = [];
// T83 followup 2: the frame's csp attribute makes Chromium refuse to
// DISPLAY a navigation destination that lacks a matching CSP. The
// refusal lands on the error page (chrome-error loc), not the
// artifact URL, so it gets its own list, asserted by the navnow leg.
const cspRefusals: string[] = [];
function isKnownArtifactBlock(text: string): boolean {
	return (
		text.includes("because the document's frame is sandboxed") ||
		text.includes("violates the following Content Security Policy")
	);
}
page.on("console", (msg) => {
	if (msg.type() === "error") {
		const text = msg.text().slice(0, 300);
		consoleErrors.push(text);
		const url = msg.location().url;
		if (url.includes("/api/artifact")) {
			artifactBlocks.push(text);
			artifactBlockUrls.push(url);
		}
		if (text.includes("The embedder requires it to enforce")) {
			cspRefusals.push(text);
		}
	}
});
// T89: every 4xx/5xx response is recorded route-specifically; the final
// checks require the list to equal exactly the deliberate failures (see
// EXPECTED_FAILED). Server errors keep their URL-plus-body stdout line:
// a bare console 500 gives no route to chase, and it costs nothing.
type FailedResponse = { status: number; method: string; pathname: string };
const failedResponses: FailedResponse[] = [];
page.on("response", (res) => {
	if (res.status() >= 500) {
		void res.text().then((body) => {
			console.log("SMOKE-500", res.status(), res.url(), body.slice(0, 200));
		});
	}
	if (res.status() >= 400) {
		const req = res.request();
		failedResponses.push({
			status: res.status(),
			method: req.method(),
			pathname: new URL(req.url()).pathname,
		});
	}
});
// T89: pageerrors are their own check — never mingled with console errors.
const pageErrors: string[] = [];
page.on("pageerror", (err) =>
	pageErrors.push(`pageerror: ${String(err).slice(0, 300)}`),
);
// T38: twins are on-demand — count /api/twins fetches from navigation on.
let twinsFetches = 0;
page.on("request", (req) => {
	if (new URL(req.url()).pathname === "/api/twins") twinsFetches++;
});

try {
	await page.goto(srv.url, { waitUntil: "load" });
	await page.waitForSelector("#chatmsgs", { timeout: 10_000 });
	// T39: the app boots behind /api/auth/state; wait for admission
	// before screenshotting or the shot catches empty panes.
	await page.waitForFunction(
		() => (document.getElementById("set-auth")?.textContent ?? "") !== "…",
		undefined,
		{ timeout: 15_000 },
	);
	check(
		"page loads with chat + brand",
		await page.locator(".brand").isVisible(),
	);
	check(
		"output pane exists",
		(await page.locator("#pane-output").count()) === 1,
	);
	check(
		"smoke hook exposed",
		await page.evaluate(() => typeof window.__smoke?.renderRow === "function"),
	);
	await page.screenshot({ path: path.join(OUT, "1-load.png") });

	// T49/D39: workspace mode trusts by default — the Settings row
	// says on. The panel collapses after so later shots keep their
	// framing.
	await page.click('#crail button[data-crview="rview-settings"]');
	await page.waitForFunction(
		() => (document.getElementById("set-trust")?.textContent ?? "") !== "…",
		undefined,
		{ timeout: 10_000 },
	);
	check(
		"t49 trust row shows on (workspace default)",
		((await page.locator("#set-trust").textContent()) ?? "").trim() === "on",
	);
	check(
		"t49 unloaded note hides when trusted",
		(await page.locator("#set-trust-note:visible").count()) === 0,
	);
	await page.screenshot({ path: path.join(OUT, "38-t49-trust-on.png") });
	await page.click("#collapsebtn");

	// Real chat roundtrip through the actual composer.
	await page.fill("#chatinput", "SMOKE-PROBE-UI");
	await page.click("#sendbtn");
	await page.waitForFunction(
		() =>
			[...document.querySelectorAll("#pane-chat .msg.agent .body p")].some(
				(p) => (p.textContent ?? "").includes("SMOKE-PROBE-UI"),
			),
		undefined,
		{ timeout: 30_000 },
	);
	check("echo roundtrip renders in chat", true);
	await page.screenshot({ path: path.join(OUT, "2-chat.png") });

	// T69: a double-Enter with an attached image dispatches exactly one
	// turn — the image payload is captured + cleared atomically at
	// dispatch, like the text. Delay the ack so both Enters land
	// in-flight, then count POSTs + user bubbles. (Text-only double-send
	// was already safe via the input clear; the button hides during runs,
	// so Enter is the honest double-dispatch vector.)
	let sendPosts = 0;
	await page.route("**/api/chat/send", async (route) => {
		sendPosts++;
		await new Promise((r) => setTimeout(r, 800));
		await route.continue();
	});
	try {
		const usersBefore = await page.locator("#pane-chat .msg.user").count();
		// pushImage returns the staged count; assert it so the proof
		// below cannot pass vacuously on a missing seam.
		const staged = await page.evaluate(
			() =>
				window.__smoke?.pushImage({
					base64Data: "iVBORw0KGgo=",
					mediaType: "image/png",
				}) ?? -1,
		);
		check("double-send proof stages one image", staged === 1, `n=${staged}`);
		await page.fill("#chatinput", "SMOKE-DOUBLE-SEND");
		await page.press("#chatinput", "Enter");
		await page.press("#chatinput", "Enter");
		await page.waitForFunction(
			() =>
				[...document.querySelectorAll("#pane-chat .msg.agent .body p")].some(
					(p) => (p.textContent ?? "").includes("SMOKE-DOUBLE-SEND"),
				),
			undefined,
			{ timeout: 30_000 },
		);
		const usersAfter = await page.locator("#pane-chat .msg.user").count();
		check(
			"double send dispatches one POST",
			sendPosts === 1,
			`posts=${sendPosts}`,
		);
		check(
			"double send renders one user bubble",
			usersAfter - usersBefore === 1,
			`delta=${usersAfter - usersBefore}`,
		);
	} finally {
		await page.unroute("**/api/chat/send");
	}

	// T37 cards: render one of each row shape into the live transcript.
	// The live echo session also renders its own system cards
	// (reminderChild), so synthetic assertions use the before/after delta
	// and text-scoped queries, never absolute counts.
	const cardDelta = await page.evaluate(() => {
		const rows = [
			{
				kind: "toolCall",
				tool: "bash",
				status: "completed",
				hint: "centrs discover",
				output: "found 1\n",
				itemId: "smoke-bash-1",
			},
			{
				kind: "toolCall",
				tool: "write_file",
				status: "completed",
				hint: "router.toml",
				itemId: "smoke-patch-1",
				patch: { added: 2, removed: 1, files: 1 },
				patchRef: "smoke-ref-1",
			},
			{
				kind: "toolCall",
				tool: "bash",
				status: "failed",
				hint: "exit 3",
				failureReason: "process exited with status 1",
				output: "boom\n",
				itemId: "smoke-fail-1",
			},
			{
				kind: "subagent",
				status: "completed",
				hint: "research",
				objective: "Survey the docs",
				childSessionId: "child-12345678",
				resultSummary: "three pages read",
				controlStatus: "completed",
				itemId: "smoke-sub-1",
			},
			{
				kind: "reasoning",
				status: "completed",
				text: "step one\nstep two",
				itemId: "smoke-reason-1",
			},
			{
				kind: "toolCall",
				tool: "bash",
				status: "inProgress",
				hint: "sleep 60",
				itemId: "smoke-run-1",
			},
		];
		const box = document.querySelector("#pane-chat .msgs");
		if (!box) throw new Error("chat transcript missing");
		const hook = window.__smoke;
		if (!hook) throw new Error("smoke hook missing");
		const before = box.querySelectorAll(".tcard").length;
		for (const r of rows) box.appendChild(hook.renderRow(r));
		box.scrollTop = box.scrollHeight;
		return box.querySelectorAll(".tcard").length - before;
	});
	check("six cards render", cardDelta === 6, `delta got ${cardDelta}`);
	const failCard = page.locator("#pane-chat .tcard", { hasText: "exit 3" });
	check(
		"failed pill renders",
		(await failCard.locator(".pill.bad").count()) === 1,
	);
	// T46: done is the absence of a pill; the blue dot lives on the
	// active row only; friendly names carry the raw kind as a caption.
	const doneCard = page.locator("#pane-chat .tcard", {
		hasText: "centrs discover",
	});
	check("done pills dropped", (await doneCard.locator(".pill").count()) === 0);
	check(
		"completed cards show no dot",
		(await doneCard.locator(".who .dot").count()) === 0,
	);
	const runCard = page.locator("#pane-chat .tcard", { hasText: "sleep 60" });
	const runPill = (await runCard.locator(".who .pill").textContent()) ?? "";
	check(
		"active row keeps blue dot plus running word",
		(await runCard.locator(".who .dot").count()) === 1 &&
			runPill.includes("running"),
		runPill,
	);
	const whoText = async (
		hasText: string,
	): Promise<{ name: string | null; cap: string | null }> => {
		const who = page.locator("#pane-chat .tcard", { hasText }).locator(".who");
		return {
			name: await who.locator(".tname").textContent(),
			cap: await who.locator(".kindcap").textContent(),
		};
	};
	const toolWho = await whoText("centrs discover");
	check(
		"tool card shows friendly name plus kind caption",
		toolWho.name === "Tool · bash" && toolWho.cap === "toolCall",
		JSON.stringify(toolWho),
	);
	const subWho = await whoText("Survey the docs");
	check(
		"subagent card shows friendly name plus kind caption",
		subWho.name === "Subagent · research" && subWho.cap === "subagent",
		JSON.stringify(subWho),
	);
	const reasonWho = await whoText("step one");
	check(
		"reasoning card shows friendly name plus kind caption",
		reasonWho.name === "Thinking" && reasonWho.cap === "reasoning",
		JSON.stringify(reasonWho),
	);
	const fills = await page.evaluate(() => {
		const card = document.querySelector("#pane-chat .tcard .body");
		const agents = [
			...document.querySelectorAll("#pane-chat .msg.agent:not(.tcard) .body"),
		];
		const agent =
			agents.find((b) => (b.textContent ?? "").includes("SMOKE-PROBE-UI")) ??
			agents[0] ??
			null;
		const g = (el: Element | null, prop: string): string =>
			el ? getComputedStyle(el).getPropertyValue(prop) : "missing";
		return {
			cardBg: g(card, "background-color"),
			agentBg: g(agent, "background-color"),
			agentRadius: g(agent, "border-top-left-radius"),
		};
	});
	check(
		"card bodies are outline-only, agent replies stay filled",
		fills.cardBg === "rgba(0, 0, 0, 0)" &&
			fills.agentBg !== "missing" &&
			fills.agentBg !== "rgba(0, 0, 0, 0)",
		JSON.stringify(fills),
	);
	check(
		"bubbles fully rounded",
		fills.agentRadius === "12px",
		fills.agentRadius,
	);
	const patchCard = page.locator("#pane-chat .tcard", {
		hasText: "router.toml",
	});
	check(
		"patch line renders",
		(await patchCard.locator(".patchline .add").count()) === 1,
	);
	check(
		"subagent result renders",
		await page.locator("#pane-chat .tres").isVisible(),
	);
	// T44 regression: cards must span the column, not huddle at content width.
	const widths = await page.evaluate(() => {
		const box = document.querySelector("#pane-chat .msgs");
		if (!box) throw new Error("chat transcript missing");
		const card = box.querySelector(".tcard");
		if (!card) throw new Error("no transcript card rendered");
		return {
			box: box.clientWidth,
			card: Math.round(card.getBoundingClientRect().width),
		};
	});
	check(
		"cards span the column",
		widths.card > widths.box * 0.5,
		JSON.stringify(widths),
	);
	const wrapping = await page.evaluate(() => {
		const p = document.querySelector("#pane-chat .tcard .body p");
		return p ? getComputedStyle(p).whiteSpace : "no card text";
	});
	check(
		"transcript text preserves line breaks",
		wrapping === "pre-wrap",
		wrapping,
	);
	await page.screenshot({ path: path.join(OUT, "3-cards.png") });

	// Open-in-tab wiring: fake ref must open the pane with an honest error.
	await page
		.locator("#pane-chat .tcard button", { hasText: "Open diff" })
		.click();
	await page.waitForSelector("#pane-output.active", { timeout: 10_000 });
	await page.waitForFunction(
		() =>
			document.getElementById("out-lede")?.textContent !==
			"fetching from the agent session…",
		undefined,
		{ timeout: 15_000 },
	);
	const lede = (await page.locator("#out-lede").textContent()) ?? "";
	const outBody = (await page.locator("#out-body").textContent()) ?? "";
	check(
		"output tab opens with honest fetch error",
		lede.includes("fetch failed") && outBody.includes("unavailable"),
		`${lede} / ${outBody.slice(0, 80)}`,
	);
	await page.screenshot({ path: path.join(OUT, "4-output-tab.png") });

	// T38: device card shows the cdb link (device cdb key, D23).
	const devLive = await page
		.locator("#devlist .dev .live")
		.first()
		.textContent();
	check(
		"device card shows cdb link",
		devLive?.includes("cdb smoke-cdb") === true,
		devLive ?? "no card",
	);

	// T38: twins on-demand — no fetch at boot, fetch on first tab show.
	check(
		"twins not fetched at boot",
		twinsFetches === 0,
		`fetches: ${twinsFetches}`,
	);
	// The right panel boots collapsed: the crail button is the real path
	// (it expands the panel and shows the Twins view, firing the fetch).
	await page.locator('button[data-crview="rview-twins"]').click();
	await page.waitForSelector("#rview-twins.active", { timeout: 10_000 });
	await page.waitForFunction(
		() => (document.getElementById("twinlist")?.children.length ?? 0) > 0,
		undefined,
		{ timeout: 30_000 },
	);
	check(
		"twins tab fetches on first show",
		twinsFetches >= 1,
		`fetches: ${twinsFetches}`,
	);
	const twinsPopulated = await page.evaluate(() => {
		const box = document.getElementById("twinlist");
		if (!box) throw new Error("twins pane missing");
		return box.querySelectorAll(".twin, .setnote").length;
	});
	check(
		"twins pane populates (cards or honest note)",
		twinsPopulated > 0,
		`rows: ${twinsPopulated}`,
	);
	await page.screenshot({ path: path.join(OUT, "5-twins.png") });

	// T46: a real doctor alert renders as an uncrowded card — title over
	// body, not jammed on one line. The panel is expanded by the twins
	// leg above, so the rbar tab is the real path here.
	await page.locator('button[data-rview="rview-alerts"]').click();
	await page.waitForSelector("#rview-alerts.active", { timeout: 10_000 });
	const action = page.locator("#alertlist .action", {
		hasText: "smoke-bogus is missing",
	});
	check("real doctor alert renders", (await action.count()) === 1);
	const stacked = await page.evaluate(() => {
		const b = document.querySelector("#alertlist .action b");
		const body = document.querySelector("#alertlist .action .abody");
		if (!b || !body) return "missing nodes";
		const rb = b.getBoundingClientRect();
		const rt = body.getBoundingClientRect();
		return rb.bottom <= rt.top
			? "stacked"
			: `overlap ${rb.bottom} vs ${rt.top}`;
	});
	check("alert title sits above its body", stacked === "stacked", stacked);
	await page.screenshot({ path: path.join(OUT, "6-alerts.png") });

	// Diff renderer against a real-shaped patch document (shape verified
	// against a live item/readOutput body in T37; hermetic fixture here).
	const diffCounts = await page.evaluate(() => {
		const doc = {
			files: [
				{
					path: "/tmp/demo/router.toml",
					hunks: [
						{
							oldStart: 1,
							oldLines: 3,
							newStart: 1,
							newLines: 3,
							lines: [" a=1", "-b=2", "+b=3", " c=4"],
						},
					],
				},
			],
		};
		const host = document.createElement("div");
		const hook = window.__smoke;
		if (!hook) throw new Error("smoke hook missing");
		hook.renderPatch(host, doc);
		const q = (s: string) => host.querySelectorAll(s).length;
		return { files: q(".dl-file"), add: q(".dl-add"), del: q(".dl-del") };
	});
	check(
		"diff renderer colors patch lines",
		diffCounts.files === 1 && diffCounts.add === 1 && diffCounts.del === 1,
		JSON.stringify(diffCounts),
	);

	// T39: the lock screen gates an encrypted workspace end to end —
	// wrong password errors, right password boots the app. centrs is
	// required (see header): without it the gate is unverifiable.
	const centrsProbe = childProcess.spawnSync("centrs", ["--version"]);
	if (centrsProbe.error || centrsProbe.status !== 0) {
		throw new Error("auth smoke needs centrs on PATH");
	}
	const lockWs = makeWorkspace();
	nodeFs.copyFileSync(
		path.join(ROOT, "tests", "fixtures", "cdb-encrypted-empty.cdb"),
		path.join(lockWs, "device.cdb"),
	);
	const lockSrv = await startServer({
		dataHome: SMOKE_DATA_HOME,
		workspace: lockWs,
		provider: "echo",
		museHome: makeHome(),
	});
	try {
		await page.goto(lockSrv.url, { waitUntil: "load" });
		await page.waitForSelector("#lockscreen.open", { timeout: 10_000 });
		// Attached before unlock: the batch fires after unlock+reload.
		const lockBatch = watchAppBatch(page);
		const lockSub = (await page.locator("#locksub").textContent()) ?? "";
		check(
			"lock screen shows for encrypted CDB",
			lockSub.includes("device.cdb"),
			lockSub,
		);
		await page.fill("#lockpw", "wrong");
		await page.click("#lockgo");
		await page.waitForFunction(
			() => document.getElementById("lockerr")?.textContent !== "",
			undefined,
			{ timeout: 10_000 },
		);
		const lockErr = (await page.locator("#lockerr").textContent()) ?? "";
		check("wrong password errors", lockErr === "wrong CDB password", lockErr);
		await page.screenshot({ path: path.join(OUT, "8-lock.png") });
		await page.fill("#lockpw", "t39-fixture-password");
		await page.click("#lockgo");
		await page.waitForFunction(
			() =>
				!document.getElementById("lockscreen")?.classList.contains("open") &&
				(document.getElementById("set-auth")?.textContent ?? "").startsWith(
					"unlocked",
				),
			undefined,
			{ timeout: 30_000 },
		);
		const authRow = (await page.locator("#set-auth").textContent()) ?? "";
		check(
			"right password boots the app",
			authRow === "unlocked (workspace)",
			authRow,
		);
		await lockBatch;
		await page.screenshot({ path: path.join(OUT, "9-unlocked.png") });
	} finally {
		await lockSrv.stop();
	}

	// T39: the bypass hatch enters straight through (honestly labeled).
	const openWs = makeWorkspace();
	const openInit = childProcess.spawnSync("centrs", ["devices", "init"], {
		env: { ...process.env, CENTRS_CDB_FILE: path.join(openWs, "device.cdb") },
	});
	if (openInit.error || openInit.status !== 0) {
		throw new Error("auth smoke needs working centrs devices init");
	}
	const openSrv = await startServer({
		dataHome: SMOKE_DATA_HOME,
		allowOpenCdb: true,
		workspace: openWs,
		provider: "echo",
		museHome: makeHome(),
	});
	try {
		await page.goto(openSrv.url, { waitUntil: "load" });
		// Attached before boot: enterApp fires the batch on admission.
		const openBatch = watchAppBatch(page);
		await page.waitForFunction(
			() => (document.getElementById("set-auth")?.textContent ?? "") !== "…",
			undefined,
			{ timeout: 15_000 },
		);
		const overlays = await page.evaluate(
			() =>
				document.getElementById("lockscreen")?.classList.contains("open") ===
					true ||
				document.getElementById("guidescreen")?.classList.contains("open") ===
					true,
		);
		check("bypass enters without overlays", overlays === false);
		const bypassRow = (await page.locator("#set-auth").textContent()) ?? "";
		check(
			"bypass is honestly labeled",
			bypassRow === "bypassed (open CDB)",
			bypassRow,
		);
		await openBatch;
		await page.screenshot({ path: path.join(OUT, "10-bypass.png") });
	} finally {
		await openSrv.stop();
	}

	// T64: a workspace without device.cdb routes to setup guidance
	// (fail-closed binding: the server never falls back to the
	// operator store). The full creation flow lands with T40.
	const missWs = makeWorkspace();
	const missSrv = await startServer({
		dataHome: SMOKE_DATA_HOME,
		workspace: missWs,
		provider: "echo",
		museHome: makeHome(),
	});
	try {
		await page.goto(missSrv.url, { waitUntil: "load" });
		await page.waitForSelector("#guidescreen.open", { timeout: 10_000 });
		const guideTitle = (await page.locator("#guidetitle").textContent()) ?? "";
		check(
			"missing CDB routes to setup guidance",
			guideTitle === "No device registry yet",
			guideTitle,
		);
		const guideSub = (await page.locator("#guidesub").textContent()) ?? "";
		check(
			"missing guidance names the bound path",
			guideSub.includes("device.cdb"),
			guideSub,
		);
		await page.screenshot({ path: path.join(OUT, "11-missing.png") });
	} finally {
		await missSrv.stop();
	}

	// T46: no-workspace mode boots honest — the composer says what the
	// mode can do instead of promising a network that is not attached.
	// The inventory there is the operator's real CDB, so serve a fresh
	// empty store for this leg (never the operator's registry).
	let hermeticCdb: string | undefined;
	const emptyCdb = path.join(mktmp("ui-smoke-cdb-"), "empty.cdb");
	const cdbInit = childProcess.spawnSync("centrs", ["devices", "init"], {
		env: { ...process.env, CENTRS_CDB_FILE: emptyCdb },
	});
	if (!cdbInit.error && cdbInit.status === 0) hermeticCdb = emptyCdb;
	const nws = await startServer({
		dataHome: SMOKE_DATA_HOME,
		allowOpenCdb: true,
		noWorkspace: true,
		provider: "echo",
		museHome: makeHome(),
		cdbFile: hermeticCdb,
	});
	try {
		await page.goto(nws.url, { waitUntil: "load" });
		await page.waitForSelector("#chatmsgs", { timeout: 10_000 });
		await page.waitForFunction(
			() =>
				(document.getElementById("chatinput") as HTMLTextAreaElement | null)
					?.placeholder !== "Ask about this network…",
			undefined,
			{ timeout: 10_000 },
		);
		if (hermeticCdb !== undefined) {
			await page.waitForFunction(
				() =>
					document
						.getElementById("leftfoot")
						?.textContent?.includes("devices") === true,
				undefined,
				{ timeout: 15_000 },
			);
			const nwsFoot = await page.locator("#leftfoot").textContent();
			check(
				"no-workspace registry is hermetically empty",
				nwsFoot === "0 devices · centrs CDB",
				nwsFoot ?? "missing",
			);
		}
		const nwsPlaceholder = await page
			.locator("#chatinput")
			.getAttribute("placeholder");
		check(
			"no-workspace composer copy",
			nwsPlaceholder === "Ask about your devices (no workspace attached)…",
			nwsPlaceholder ?? "missing",
		);
		// T49/D39: no workspace, nothing to trust — the row says so.
		check(
			"t49 trust row shows no workspace (no-ws mode)",
			((await page.locator("#set-trust").textContent()) ?? "").trim() ===
				"no workspace",
		);
		// A full echo turn must restore the no-workspace copy, not the
		// workspace one (setRunning placeholder reset is mode-aware).
		await page.fill("#chatinput", "SMOKE-PROBE-NOWS");
		await page.click("#sendbtn");
		await page.waitForFunction(
			() =>
				[...document.querySelectorAll("#pane-chat .msg.agent .body p")].some(
					(p) => (p.textContent ?? "").includes("SMOKE-PROBE-NOWS"),
				),
			undefined,
			{ timeout: 30_000 },
		);
		await page.waitForFunction(
			() =>
				(document.getElementById("stopbtn") as HTMLButtonElement | null)?.style
					.display === "none",
			undefined,
			{ timeout: 30_000 },
		);
		const nwsPlaceholderAfter = await page
			.locator("#chatinput")
			.getAttribute("placeholder");
		check(
			"no-workspace composer copy survives a turn",
			nwsPlaceholderAfter === "Ask about your devices (no workspace attached)…",
			nwsPlaceholderAfter ?? "missing",
		);
		await page.screenshot({ path: path.join(OUT, "7-no-workspace.png") });
	} finally {
		await nws.stop();
	}

	// T49/D39: --no-trust-workspace spawns untrusted — the row says
	// off and the one-line note names what does not load.
	const untrustedSrv = await startServer({
		dataHome: SMOKE_DATA_HOME,
		allowOpenCdb: true,
		workspace: makeWorkspace(),
		provider: "echo",
		museHome: makeHome(),
		trustWorkspace: false,
	});
	try {
		await page.goto(untrustedSrv.url, { waitUntil: "load" });
		const untrustedBatch = watchAppBatch(page);
		await page.waitForFunction(
			() => (document.getElementById("set-auth")?.textContent ?? "") !== "…",
			undefined,
			{ timeout: 15_000 },
		);
		await page.click('#crail button[data-crview="rview-settings"]');
		await page.waitForFunction(
			() => (document.getElementById("set-trust")?.textContent ?? "") !== "…",
			undefined,
			{ timeout: 10_000 },
		);
		check(
			"t49 trust row shows off when untrusted",
			((await page.locator("#set-trust").textContent()) ?? "").trim() === "off",
		);
		const trustNote =
			(await page.locator("#set-trust-note").textContent()) ?? "";
		check(
			"t49 unloaded note names AGENTS.md and skills",
			(await page.locator("#set-trust-note:visible").count()) === 1 &&
				trustNote.includes("AGENTS.md") &&
				trustNote.includes("skills"),
			trustNote,
		);
		await page.screenshot({ path: path.join(OUT, "39-t49-trust-off.png") });
		await untrustedBatch;
	} finally {
		await untrustedSrv.stop();
	}

	// T40: the no-workspace picker lists registry entries (live + dead),
	// opens in place via a restart command, prunes the dead, and creates
	// at the default location. Temp data home + creation root (hermetic).
	const pickDh = mktmp("ui-smoke-pickdh-");
	const pickLive = makeWorkspace();
	registerWorkspace(registryFile(pickDh), "smoke-live", pickLive);
	registerWorkspace(
		registryFile(pickDh),
		"smoke-dead",
		path.join(pickDh, "gone"),
	);
	const pickNets = path.join(pickDh, "nets");
	const pickSrv = await startServer({
		allowOpenCdb: true,
		noWorkspace: true,
		provider: "echo",
		museHome: makeHome(),
		cdbFile: hermeticCdb,
		dataHome: pickDh,
		defaultWorkspaceDir: pickNets,
	});
	try {
		await page.goto(pickSrv.url, { waitUntil: "load" });
		const pickBatch = watchAppBatch(page);
		await page.waitForSelector("#crviewbtn-ws:visible", { timeout: 15_000 });
		await page.click("#crviewbtn-ws");
		await page.waitForSelector("#rview-ws.active", { timeout: 10_000 });
		const pkList = (await page.locator("#pklist").textContent()) ?? "";
		check("picker lists the live entry", pkList.includes("smoke-live"), pkList);
		check(
			"picker marks the dead entry",
			pkList.includes("smoke-dead (missing)"),
			pkList,
		);
		const createNote =
			(await page.locator("#pkcreatenote").textContent()) ?? "";
		check(
			"picker names the default location",
			createNote.includes(pickNets),
			createNote,
		);
		await page.click("#pkprune");
		await page.waitForFunction(
			() =>
				!(document.getElementById("pklist")?.textContent ?? "").includes(
					"smoke-dead",
				),
			undefined,
			{ timeout: 10_000 },
		);
		check("prune drops the dead entry", true);
		await page.click("#pklist button.minibtn");
		await page.waitForFunction(
			() =>
				(document.getElementById("pkcmd")?.textContent ?? "").includes("serve"),
			undefined,
			{ timeout: 10_000 },
		);
		const openCmd = (await page.locator("#pkcmd").textContent()) ?? "";
		check(
			"open prints the restart command",
			openCmd.includes("serve") && openCmd.includes(pickLive),
			openCmd,
		);
		await page.fill("#pkname", "../evil");
		await page.click("#pkcreate");
		await page.waitForFunction(
			() => (document.getElementById("pkerr")?.textContent ?? "") !== "",
			undefined,
			{ timeout: 10_000 },
		);
		const wsErr = (await page.locator("#pkerr").textContent()) ?? "";
		check(
			"bad scaffold name fails honestly",
			wsErr.includes("one path segment"),
			wsErr,
		);
		await page.fill("#pkname", "smoke-new");
		await page.click("#pkcreate");
		await page.waitForFunction(
			() =>
				(document.getElementById("pklist")?.textContent ?? "").includes(
					"smoke-new",
				),
			undefined,
			{ timeout: 30_000 },
		);
		const newCmd = (await page.locator("#pkcmd").textContent()) ?? "";
		const newSteer = (await page.locator("#pksteer").textContent()) ?? "";
		check(
			"create scaffolds at the default location",
			newCmd.includes(path.join(pickNets, "smoke-new")),
			newCmd,
		);
		check(
			"create steers to WinBox encryption",
			newSteer.includes("WinBox"),
			newSteer,
		);
		// T93: the template select defaults to minimal and scaffolds
		// network on request. No new temp roots: both creates land in
		// the picker's own creation dir.
		const tplDefault = await page.locator("#pktemplate").inputValue();
		check(
			"template select defaults to minimal",
			tplDefault === "minimal",
			tplDefault,
		);
		await page.selectOption("#pktemplate", "network");
		const netNote = (await page.locator("#pkcreatenote").textContent()) ?? "";
		check(
			"create note follows the template",
			netNote.includes("network template"),
			netNote,
		);
		await page.fill("#pkname", "smoke-net");
		await page.click("#pkcreate");
		await page.waitForFunction(
			() =>
				(document.getElementById("pklist")?.textContent ?? "").includes(
					"smoke-net",
				),
			undefined,
			{ timeout: 30_000 },
		);
		const netCmd = (await page.locator("#pkcmd").textContent()) ?? "";
		check(
			"network create scaffolds at the default location",
			netCmd.includes(path.join(pickNets, "smoke-net")),
			netCmd,
		);
		const netStart = path.join(pickNets, "smoke-net", "START-HERE.md");
		check(
			"network create writes the full starter",
			nodeFs.existsSync(netStart),
			netStart,
		);
		const netToml = nodeFs.readFileSync(
			path.join(pickNets, "smoke-net", "workspace.toml"),
			"utf8",
		);
		check(
			"network create stamps template provenance",
			netToml.includes("[template]") && netToml.includes('name = "network"'),
			netToml.slice(-120),
		);
		check(
			"network create keeps the manifest out",
			!nodeFs.existsSync(path.join(pickNets, "smoke-net", "template.toml")),
		);
		await page.screenshot({ path: path.join(OUT, "12b-picker-template.png") });
		await pickBatch;
		await page.screenshot({ path: path.join(OUT, "12-picker.png") });
	} finally {
		await pickSrv.stop();
	}

	// T48: the set-credentials modal end to end. The seeded record has
	// a user but no password, so the card carries the clear affordance;
	// saving flips it, and the secret never reads back out.
	const credWs = makeWorkspace();
	const credCdb = path.join(credWs, "device.cdb");
	const credEnv = { ...process.env, CENTRS_CDB_FILE: credCdb };
	const credInit = childProcess.spawnSync("centrs", ["devices", "init"], {
		env: credEnv,
	});
	const credAdd = childProcess.spawnSync(
		"centrs",
		["devices", "add", "smoke-cdb", "--user", "smoke-admin"],
		{ env: credEnv },
	);
	if (
		credInit.error ||
		credInit.status !== 0 ||
		credAdd.error ||
		credAdd.status !== 0
	) {
		throw new Error("credentials smoke needs working centrs devices init/add");
	}
	const credSrv = await startServer({
		dataHome: SMOKE_DATA_HOME,
		allowOpenCdb: true,
		workspace: credWs,
		provider: "echo",
		museHome: makeHome(),
	});
	try {
		await page.goto(credSrv.url, { waitUntil: "load" });
		const credBatch = watchAppBatch(page);
		// Singular matters: one device renders "1 device", not "devices".
		await page.waitForFunction(
			() =>
				/\d+ device/.test(
					document.getElementById("leftfoot")?.textContent ?? "",
				),
			undefined,
			{ timeout: 15_000 },
		);
		await page.waitForSelector("#devlist .dev .credrow button", {
			timeout: 15_000,
		});
		const credLabel =
			(await page.locator("#devlist .dev .credrow button").textContent()) ?? "";
		check(
			"card without a password gets the set-credentials affordance",
			credLabel === "Set credentials",
			credLabel,
		);
		await page.screenshot({ path: path.join(OUT, "13-creds-card.png") });
		// The dead-host stats call fails honestly, and the device tab
		// offers the same modal with the failure as context.
		await page.locator("#devlist .dev .name").first().click();
		await page.waitForSelector("#pane-device.active", { timeout: 10_000 });
		await page.waitForFunction(
			() =>
				(document.getElementById("pdev-note")?.textContent ?? "") !==
				"checking…",
			undefined,
			{ timeout: 60_000 },
		);
		check(
			"device tab failure shows Set credentials",
			(await page.locator("#pdev-cred:visible").count()) === 1,
		);
		await page.click("#pdev-cred");
		await page.waitForSelector("#credmodal.open", { timeout: 10_000 });
		await page.waitForFunction(
			() =>
				(document.getElementById("credctx")?.textContent ?? "") !== "loading…",
			undefined,
			{ timeout: 15_000 },
		);
		const credCtx = (await page.locator("#credctx").textContent()) ?? "";
		check(
			"modal shows redacted record context plus the failure",
			credCtx.includes("user smoke-admin") &&
				credCtx.includes("password not set") &&
				credCtx.includes("last error:"),
			credCtx,
		);
		const pwField = await page.evaluate(() => {
			const el = document.getElementById("credf-password") as HTMLInputElement;
			const cs = getComputedStyle(el) as unknown as Record<string, string>;
			return {
				type: el.type,
				autocomplete: el.getAttribute("autocomplete"),
				masked: cs["webkitTextSecurity"],
			};
		});
		check(
			"password field is no-echo",
			pwField.type === "text" &&
				pwField.autocomplete === "off" &&
				pwField.masked === "disc",
			JSON.stringify(pwField),
		);
		await page.screenshot({ path: path.join(OUT, "14-creds-modal.png") });
		await page.fill("#credf-password", "t48-smoke-secret");
		await page.click("#credsave");
		await page.waitForFunction(
			() =>
				document.getElementById("credmodal")?.classList.contains("open") ===
				false,
			undefined,
			{ timeout: 30_000 },
		);
		await page.waitForFunction(
			() =>
				document.querySelector("#devlist .dev .credrow button")?.textContent ===
				"Credentials",
			undefined,
			{ timeout: 30_000 },
		);
		check("save flips the card affordance", true);
		const leaked = await page.evaluate(async () => {
			const r = await fetch("/api/devices/smoke-gw/credentials");
			return (await r.text()).includes("t48-smoke-secret");
		});
		check("saved secret never reads back out", leaked === false);
		await credBatch;
		await page.screenshot({ path: path.join(OUT, "15-creds-saved.png") });
	} finally {
		await credSrv.stop();
	}

	// T72: credentials modal hardening — 409 re-bases without clobbering
	// typed input, double-submit guard, busy-blocks-close, Enter submit,
	// disc-masked manager-safe secret field, failure whitelist. Fresh
	// server + seeded CDB so every leg runs against known record state.
	// Fixture secrets only; each failure leg pins its typed secret
	// nowhere in the serialized DOM.
	const t72Ws = makeWorkspace();
	const t72Cdb = path.join(t72Ws, "device.cdb");
	const t72Env = { ...process.env, CENTRS_CDB_FILE: t72Cdb };
	const t72Init = childProcess.spawnSync("centrs", ["devices", "init"], {
		env: t72Env,
	});
	const t72Add = childProcess.spawnSync(
		"centrs",
		["devices", "add", "smoke-cdb", "--user", "t72-admin"],
		{ env: t72Env },
	);
	if (
		t72Init.error ||
		t72Init.status !== 0 ||
		t72Add.error ||
		t72Add.status !== 0
	) {
		throw new Error("t72 smoke needs working centrs devices init/add");
	}
	const t72Srv = await startServer({
		dataHome: SMOKE_DATA_HOME,
		allowOpenCdb: true,
		workspace: t72Ws,
		provider: "echo",
		museHome: makeHome(),
	});
	// T72(f): the generic fallback warns with the raw why (never the
	// DOM); warnings are collected to pin that the fallback fired.
	const t72Warns: string[] = [];
	page.on("console", (msg) => {
		if (msg.type() === "warning") t72Warns.push(msg.text().slice(0, 300));
	});
	// T72(b/d): count credentials POSTs for the double-submit + Enter legs.
	let t72CredPosts = 0;
	page.on("request", (req) => {
		if (
			req.method() === "POST" &&
			new URL(req.url()).pathname === "/api/devices/smoke-gw/credentials"
		)
			t72CredPosts++;
	});
	try {
		await page.goto(t72Srv.url, { waitUntil: "load" });
		const t72Batch = watchAppBatch(page);
		await page.waitForFunction(
			() =>
				/\d+ device/.test(
					document.getElementById("leftfoot")?.textContent ?? "",
				),
			undefined,
			{ timeout: 15_000 },
		);
		await page.waitForSelector("#devlist .dev .credrow button", {
			timeout: 15_000,
		});
		const t72ModalOpen = (): Promise<boolean> =>
			page.evaluate(
				() =>
					document.getElementById("credmodal")?.classList.contains("open") ===
					true,
			);
		const t72OpenModal = async (): Promise<void> => {
			await page.locator("#devlist .dev .credrow button").first().click();
			await page.waitForSelector("#credmodal.open", { timeout: 10_000 });
			await page.waitForFunction(
				() =>
					(document.getElementById("credctx")?.textContent ?? "") !==
					"loading…",
				undefined,
				{ timeout: 15_000 },
			);
		};
		const t72Field = (id: string): Promise<string> =>
			page.evaluate(
				(f) => (document.getElementById(f) as HTMLInputElement).value,
				id,
			);
		const t72SecretAbsent = async (
			secret: string,
			label: string,
		): Promise<void> => {
			// Serialized-surface pin: input *values* intentionally retain
			// on failure (review-then-retry), so only the serialized DOM
			// is pinned — an echo into ctx/err/attributes would land here.
			const hit = await page.evaluate(
				(s) => document.documentElement.outerHTML.includes(s),
				secret,
			);
			check(`${label}: typed secret nowhere in the DOM`, hit === false);
		};
		// Never throws: legs assert the closed state themselves, so a RED
		// leg cannot cascade into the next one through teardown.
		const t72WaitClosed = (): Promise<void> =>
			page
				.waitForFunction(
					() =>
						document.getElementById("credmodal")?.classList.contains("open") ===
						false,
					undefined,
					{ timeout: 30_000 },
				)
				.then(() => undefined)
				.catch(() => undefined);
		const t72EnsureClosed = async (): Promise<void> => {
			if (await t72ModalOpen()) await page.locator("#credcancel").click();
			await t72WaitClosed();
		};

		// T72(a): a 409 re-bases the snapshot + context without touching
		// typed input, so review-then-Save retries with one click.
		await t72OpenModal();
		await page.evaluate(async () => {
			const g = (await (
				await fetch("/api/devices/smoke-gw/credentials")
			).json()) as { details: unknown };
			await fetch("/api/devices/smoke-gw/credentials", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ user: "t72-other", expected: g.details }),
			});
		});
		await page.fill("#credf-user", "t72-mine");
		await page.fill("#credf-password", "t72-secret-A");
		await page.fill("#credf-sshkey", "/home/op/.ssh/t72_ed25519");
		await page.fill("#credf-profile", "t72-prof");
		await page.fill("#credf-session", "t72-sess");
		await page.click("#credsave");
		await page.waitForFunction(
			() =>
				(document.getElementById("credctx")?.textContent ?? "").includes(
					"t72-other",
				),
			undefined,
			{ timeout: 30_000 },
		);
		check("t72 409 keeps the modal open", await t72ModalOpen());
		check(
			"t72 409 preserves the typed user",
			(await t72Field("credf-user")) === "t72-mine",
			await t72Field("credf-user"),
		);
		check(
			"t72 409 preserves the typed password",
			(await t72Field("credf-password")) === "t72-secret-A",
		);
		check(
			"t72 409 preserves the typed ssh-key",
			(await t72Field("credf-sshkey")) === "/home/op/.ssh/t72_ed25519",
			await t72Field("credf-sshkey"),
		);
		check(
			"t72 409 preserves the typed profile",
			(await t72Field("credf-profile")) === "t72-prof",
		);
		check(
			"t72 409 preserves the typed session",
			(await t72Field("credf-session")) === "t72-sess",
		);
		const t72ErrA = (await page.locator("#crederr").textContent()) ?? "";
		check(
			"t72 409 explains the conflict as-is",
			t72ErrA.includes("changed while the modal was open"),
			t72ErrA,
		);
		await t72SecretAbsent("t72-secret-A", "t72 409");
		await page.screenshot({ path: path.join(OUT, "22-t72-409.png") });
		await page.click("#credsave");
		await t72WaitClosed();
		check("t72 one-click retry succeeds", !(await t72ModalOpen()));
		check(
			"t72 success clears all five fields",
			(await t72Field("credf-user")) === "" &&
				(await t72Field("credf-password")) === "" &&
				(await t72Field("credf-sshkey")) === "" &&
				(await t72Field("credf-profile")) === "" &&
				(await t72Field("credf-session")) === "",
		);

		// T72(b): double-clicking Save issues exactly one credentials POST.
		await t72OpenModal();
		t72CredPosts = 0;
		await page.fill("#credf-password", "t72-secret-B");
		await page.locator("#credsave").dblclick();
		await t72WaitClosed();
		check("t72 double-click closes the modal", !(await t72ModalOpen()));
		check(
			"t72 double-click sends exactly one POST",
			t72CredPosts === 1,
			`posts=${t72CredPosts}`,
		);

		// T72(c): while a save is in flight, every close path ignores the
		// modal — but Esc still closes the picker.
		await page.route("**/api/devices/smoke-gw/credentials", async (route) => {
			if (route.request().method() === "POST")
				await new Promise((r) => setTimeout(r, 2000));
			await route.continue();
		});
		try {
			await t72OpenModal();
			await page.fill("#credf-password", "t72-secret-C");
			await page.click("#credsave");
			await page.waitForFunction(
				() =>
					(document.getElementById("crederr")?.textContent ?? "") === "saving…",
				undefined,
				{ timeout: 10_000 },
			);
			check(
				"t72 busy disables Save",
				await page.locator("#credsave").isDisabled(),
			);
			check(
				"t72 busy disables Cancel",
				await page.locator("#credcancel").isDisabled(),
			);
			check("t72 busy disables X", await page.locator("#credx").isDisabled());
			await page.keyboard.press("Escape");
			let t72Open = await t72ModalOpen();
			if (t72Open)
				await page.locator("#credmodal").click({ position: { x: 8, y: 8 } });
			t72Open = await t72ModalOpen();
			if (t72Open)
				await page.evaluate(() => {
					(window as unknown as { closeCred: () => void }).closeCred();
				});
			t72Open = await t72ModalOpen();
			check("t72 busy blocks every close path", t72Open === true);
			check(
				"t72 busy keeps the typed password",
				(await t72Field("credf-password")) === "t72-secret-C",
			);
			await page.evaluate(() => {
				(window as unknown as { openPicker: () => void }).openPicker();
			});
			await page.waitForSelector("#picker.open", { timeout: 10_000 });
			await page.keyboard.press("Escape");
			check(
				"t72 busy still lets Esc close the picker",
				(await page.locator("#picker.open").count()) === 0,
			);
			await t72WaitClosed();
			check("t72 delayed save completes", !(await t72ModalOpen()));
			await t72SecretAbsent("t72-secret-C", "t72 busy");
		} finally {
			await page.unroute("**/api/devices/smoke-gw/credentials");
		}

		// T72(d): Enter in any field submits the modal.
		await t72OpenModal();
		t72CredPosts = 0;
		await page.fill("#credf-profile", "t72-enter-prof");
		await page.locator("#credf-profile").press("Enter");
		await t72WaitClosed();
		check(
			"t72 Enter submits the modal",
			(await t72ModalOpen()) === false && t72CredPosts === 1,
			`open=${await t72ModalOpen()} posts=${t72CredPosts}`,
		);
		await t72EnsureClosed();

		// T72(e): the secret field stays out of password managers (plain
		// text input, no autocomplete) while rendering disc-masked.
		const t72Pw = await page.evaluate(() => {
			const el = document.getElementById("credf-password") as HTMLInputElement;
			const cs = getComputedStyle(el) as unknown as Record<string, string>;
			return {
				type: el.type,
				autocomplete: el.getAttribute("autocomplete"),
				masked: cs["webkitTextSecurity"],
				spellcheck: el.getAttribute("spellcheck"),
				oneP: el.hasAttribute("data-1p-ignore"),
				lastpass: el.hasAttribute("data-lastpass-ignore"),
			};
		});
		check(
			"t72 secret field is manager-safe and disc-masked",
			t72Pw.type === "text" &&
				t72Pw.autocomplete === "off" &&
				t72Pw.masked === "disc" &&
				t72Pw.spellcheck === "false" &&
				t72Pw.oneP &&
				t72Pw.lastpass,
			JSON.stringify(t72Pw),
		);

		// T72(f): failures never render the raw server why. Park the CDB
		// so centrs answers cdb/not-found (a dynamic why outside the
		// whitelist): the modal shows the generic copy on both surfaces
		// and the raw text goes to console.warn, never the DOM.
		nodeFs.renameSync(t72Cdb, `${t72Cdb}.parked`);
		try {
			await t72OpenModal();
			const t72CtxF = (await page.locator("#credctx").textContent()) ?? "";
			check(
				"t72 unlisted GET why renders generic context",
				t72CtxF.startsWith("unavailable:") &&
					t72CtxF.includes("browser console"),
				t72CtxF,
			);
			await page.fill("#credf-user", "t72-f");
			await page.fill("#credf-password", "t72-secret-F1");
			t72CredPosts = 0;
			await page.click("#credsave");
			check(
				"t72 save without a baseline sends no POST",
				t72CredPosts === 0,
				`posts=${t72CredPosts}`,
			);
			check(
				"t72 baseline-less failure keeps the modal open",
				await t72ModalOpen(),
			);
			check(
				"t72 baseline-less failure retains the typed password",
				(await t72Field("credf-password")) === "t72-secret-F1",
			);
			await t72SecretAbsent("t72-secret-F1", "t72 GET-failure");
		} finally {
			nodeFs.renameSync(`${t72Cdb}.parked`, t72Cdb);
		}
		await page.locator("#credcancel").click();
		await t72WaitClosed();
		const t72WarnsBefore = t72Warns.length;
		await t72OpenModal();
		nodeFs.renameSync(t72Cdb, `${t72Cdb}.parked`);
		try {
			await page.fill("#credf-user", "t72-mine-f2");
			await page.fill("#credf-password", "t72-secret-F2");
			await page.fill("#credf-sshkey", "/home/op/.ssh/t72-f2_ed25519");
			await page.fill("#credf-profile", "t72-prof-f2");
			await page.fill("#credf-session", "t72-sess-f2");
			await page.click("#credsave");
			await page.waitForFunction(
				() =>
					(document.getElementById("crederr")?.textContent ?? "") !== "" &&
					(document.getElementById("crederr")?.textContent ?? "") !== "saving…",
				undefined,
				{ timeout: 30_000 },
			);
			const t72ErrF = (await page.locator("#crederr").textContent()) ?? "";
			check(
				"t72 unlisted POST why renders the generic copy",
				t72ErrF === "Couldn't save credentials — see the browser console.",
				t72ErrF,
			);
			check(
				"t72 POST failure retains all typed input",
				(await t72Field("credf-user")) === "t72-mine-f2" &&
					(await t72Field("credf-password")) === "t72-secret-F2" &&
					(await t72Field("credf-sshkey")) === "/home/op/.ssh/t72-f2_ed25519" &&
					(await t72Field("credf-profile")) === "t72-prof-f2" &&
					(await t72Field("credf-session")) === "t72-sess-f2",
			);
			await t72SecretAbsent("t72-secret-F2", "t72 POST-failure");
			check(
				"t72 raw why reaches console.warn, not the DOM",
				t72Warns.length > t72WarnsBefore &&
					t72Warns
						.slice(t72WarnsBefore)
						.some((w) => w.includes("cdb/not-found")),
				t72Warns.slice(t72WarnsBefore).join(" | "),
			);
			await page.screenshot({ path: path.join(OUT, "23-t72-generic.png") });
		} finally {
			nodeFs.renameSync(`${t72Cdb}.parked`, t72Cdb);
		}
		// Restored CDB: review-then-Save retries with one click. The
		// post-save renderDevice stats fetch is un-awaited by the app, so
		// the retry's stats response is awaited before teardown — stopping
		// the server under it logs ERR_CONNECTION_REFUSED (T39 class).
		const t72Stats = page
			.waitForResponse(
				(r) => new URL(r.url()).pathname === "/api/devices/smoke-gw/stats",
				{ timeout: 60_000 },
			)
			.catch(() => null);
		await page.click("#credsave");
		await t72WaitClosed();
		const t72RetryOk = !(await t72ModalOpen());
		check("t72 retry after restore succeeds", t72RetryOk);
		if (t72RetryOk) await t72Stats;
		await t72Batch;
	} finally {
		await t72Srv.stop();
	}

	// T84: a multi-device router.toml opens read-only in the TOML slice —
	// Save is disabled with a hand-edit note, Discard still works, and a
	// reload still lists both devices (no flattening on save).
	const t84Ws = makeWorkspace();
	nodeFs.writeFileSync(
		path.join(t84Ws, "router.toml"),
		'title = "t84 smoke"\n\n[[device]]\nid = "t84-a"\nrole = "gateway"\n\n' +
			'[[device]]\nid = "t84-b"\nrole = "gateway"\n\n[settings]\nmode = "true"\ncount = 3\n\n' +
			'[settings.proxy]\nhost = "proxy.example"\n',
	);
	const t84Srv = await startServer({
		dataHome: SMOKE_DATA_HOME,
		allowOpenCdb: true,
		workspace: t84Ws,
		provider: "echo",
		museHome: makeHome(),
	});
	try {
		await page.goto(t84Srv.url, { waitUntil: "load" });
		const t84Batch = watchAppBatch(page);
		await page.waitForFunction(
			() => (document.getElementById("set-auth")?.textContent ?? "") !== "…",
			undefined,
			{ timeout: 15_000 },
		);
		await page.waitForFunction(
			() =>
				(document.getElementById("leftfoot")?.textContent ?? "").includes(
					"2 devices",
				),
			undefined,
			{ timeout: 15_000 },
		);
		await page.locator('#wslist [data-path="router.toml"]').click();
		await page.waitForSelector("#toml-secs input, #toml-secs textarea", {
			timeout: 10_000,
		});
		check(
			"t84 save disabled on multi-device toml",
			await page.locator("#toml-save").isDisabled(),
		);
		const t84Note = (await page.locator("#toml-note").textContent()) ?? "";
		check(
			"t84 read-only note names hand edit",
			t84Note.includes("read-only") &&
				t84Note.includes("edit the file by hand"),
			t84Note,
		);
		check(
			"t84 read-only banner shows",
			(await page.locator("#toml-ro:visible").count()) === 1,
		);
		check(
			"t84 discard stays enabled",
			await page.locator("#toml-discard").isEnabled(),
		);
		const t84Disabled = await page
			.locator("#toml-secs input:disabled, #toml-secs textarea:disabled")
			.count();
		check("t84 readonly rows disabled", t84Disabled > 0, `n=${t84Disabled}`);
		await page.screenshot({ path: path.join(OUT, "16-t84-toml-readonly.png") });
		await t84Batch;
		const t84Reload = watchAppBatch(page);
		await page.reload({ waitUntil: "load" });
		await t84Reload;
		await page.waitForFunction(
			() =>
				(document.getElementById("leftfoot")?.textContent ?? "").includes(
					"2 devices",
				),
			undefined,
			{ timeout: 15_000 },
		);
		const t84Foot = (await page.locator("#leftfoot").textContent()) ?? "";
		check(
			"t84 devices survive after reload",
			t84Foot === "2 devices · router.toml" &&
				(await page.locator("#devlist .dev").count()) === 2,
			t84Foot,
		);
		await page.screenshot({ path: path.join(OUT, "17-t84-devices.png") });
	} finally {
		await t84Srv.stop();
	}

	// T83: the artifact viewer. Render primaries surface in recents;
	// a topology render job opens framed in the scripts tier with a
	// real mermaid SVG, zero outside requests, zero CSP violations
	// (live listener plus a static markup scan); a static probe page
	// blocks its inline script until the owner toggles Run scripts; a
	// navigating artifact is blanked with an inline notice; an
	// immediate navigation (before the artifact's own load) is
	// refused display by the frame's csp attribute while its request
	// still fires; each artifact tab keeps its own artifact; SVG and
	// PNG display; the report job opens static. Screenshots 24-29.
	const t83Ws = makeWorkspace();
	nodeFs.mkdirSync(path.join(t83Ws, "reports"), { recursive: true });
	nodeFs.writeFileSync(
		path.join(t83Ws, "reports", "probe.html"),
		'<!doctype html><html><body><div id="t">no</div><script>document.getElementById("t").textContent="yes";</script></body></html>\n',
	);
	nodeFs.writeFileSync(
		path.join(t83Ws, "reports", "pic.svg"),
		'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle id="smoke-svg-ok" cx="20" cy="20" r="10" fill="red"/></svg>\n',
	);
	nodeFs.writeFileSync(
		path.join(t83Ws, "reports", "dot.png"),
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
			"base64",
		),
	);
	// T83 followup: a scripts-tier escape attempt (runs only after the
	// owner's Run scripts opt-in) plus two files for the per-tab leg.
	// The escape waits past the artifact's own load: the UI detects
	// navigation by counting the frame's loads, so the artifact's
	// first load must complete before the getaway load fires.
	nodeFs.writeFileSync(
		path.join(t83Ws, "reports", "navaway.html"),
		'<!doctype html><html><body><div id="n">stay</div><script>setTimeout(() => { location.href = "http://example.invalid/"; }, 500);</script></body></html>\n',
	);
	// T83 followup 2: an IMMEDIATE escape — no setTimeout, so the
	// navigation fires during the artifact's own parse, before its
	// load completes and the load counter stays silent. The getaway
	// aims at this server's own root (200, no CSP headers): the
	// frame's csp attribute refuses to display it, but the request
	// still fires — display refusal, not exfiltration prevention.
	nodeFs.writeFileSync(
		path.join(t83Ws, "reports", "navnow.html"),
		'<!doctype html><html><body><div id="n">stay</div><script>location.href = "/";</script></body></html>\n',
	);
	nodeFs.writeFileSync(
		path.join(t83Ws, "reports", "first.html"),
		'<!doctype html><html><body><div id="who">first</div></body></html>\n',
	);
	nodeFs.writeFileSync(
		path.join(t83Ws, "reports", "second.html"),
		'<!doctype html><html><body><div id="who">second</div></body></html>\n',
	);
	const t83Srv = await startServer({
		dataHome: SMOKE_DATA_HOME,
		allowOpenCdb: true,
		workspace: t83Ws,
		provider: "echo",
		museHome: makeHome(),
	});
	try {
		await page.goto(t83Srv.url, { waitUntil: "load" });
		const t83Batch = watchAppBatch(page);
		await page.waitForFunction(
			() => (document.getElementById("set-auth")?.textContent ?? "") !== "…",
			undefined,
			{ timeout: 15_000 },
		);
		await t83Batch;
		type JobOut = { ok: boolean; dir: string; files: string[]; why?: string };
		const renderJob = (job: string, input: unknown): Promise<JobOut> =>
			page.evaluate(
				async ({ job, input }) => {
					const r = await fetch("/api/render", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ job, input }),
					});
					return (await r.json()) as JobOut;
				},
				{ job, input },
			);
		const topo = await renderJob("topology", {
			title: "smoke topo",
			nodes: [{ id: "gw" }, { id: "ap" }],
			links: [{ from: "gw", to: "ap" }],
		});
		check("t83 topology job builds", topo.ok === true, topo.why ?? "");
		const rep = await renderJob("report", {
			title: "Smoke report",
			markdown: "# Smoke report\n\n- one\n- two\n",
		});
		check("t83 report job builds", rep.ok === true, rep.why ?? "");
		// The picker tree loads once at boot; reload so the render
		// outputs and probe files list.
		const t83Reload = watchAppBatch(page);
		await page.reload({ waitUntil: "load" });
		await t83Reload;
		await page.waitForFunction(
			() => (document.getElementById("set-auth")?.textContent ?? "") !== "…",
			undefined,
			{ timeout: 15_000 },
		);
		const openFromTree = async (suffix: string): Promise<void> => {
			await page.locator("#wsadd").click();
			const row = page.locator(
				`#mview-topology .titem[data-path$="${suffix}"]`,
			);
			await row.waitFor({ timeout: 10_000 });
			await row.click();
			await page.locator("#pickeropen").click();
			await page.waitForSelector("#pane-artifact.active", { timeout: 10_000 });
			// The viewer builds the frame after its meta fetch: wait
			// for the new frame's src, not just the shown pane, or the
			// next read lands on the previous artifact's frame.
			await page.waitForSelector(`#artframe[src*="${suffix}"]`, {
				timeout: 10_000,
			});
		};
		const artFrame = page.frameLocator("#artframe");
		// Render primaries surface in recents with the ART kind.
		for (const primary of ["topology.html", "report.html"]) {
			const row = page.locator(`#wslist .docrow[data-path$="${primary}"]`);
			await row.first().waitFor({ timeout: 10_000 });
			check(
				`t83 recents lists the ${primary} primary`,
				(await row.count()) === 1 &&
					((await row.first().locator(".kchip").textContent()) ?? "") === "ART",
			);
		}
		// Offline proof: abort and record every request that is not to
		// this server's own loopback port.
		const externalHosts: string[] = [];
		const t83Port = new URL(t83Srv.url).port;
		await page.route("**/*", async (route) => {
			const u = new URL(route.request().url());
			if (
				(u.hostname === "127.0.0.1" || u.hostname === "localhost") &&
				u.port === t83Port
			) {
				await route.continue();
			} else {
				externalHosts.push(u.host);
				await route.abort();
			}
		});
		try {
			const blocksBefore = artifactBlocks.length;
			await openFromTree("topology.html");
			check(
				"t83 topology opens in the scripts tier",
				((await page.locator("#art-tier").textContent()) ?? "") === "scripts" &&
					((await page.locator("#art-why").textContent()) ?? "").includes(
						"render job",
					),
			);
			let topoFrame = page.frame({ url: /topology\.html/ });
			for (let i = 0; i < 100 && !topoFrame; i++) {
				await new Promise((r) => setTimeout(r, 100));
				topoFrame = page.frame({ url: /topology\.html/ });
			}
			check("t83 topology frame is reachable", topoFrame !== null);
			await topoFrame?.evaluate(() => {
				const w = window as unknown as { __spv: string[] };
				w.__spv = [];
				document.addEventListener("securitypolicyviolation", (e) => {
					w.__spv.push(`${e.violatedDirective} ${e.blockedURI}`);
				});
			});
			await artFrame.locator("svg .node").first().waitFor({ timeout: 30_000 });
			const topoNodes = await artFrame.locator("svg .node").count();
			check("t83 mermaid svg renders nodes", topoNodes >= 2, `n=${topoNodes}`);
			check(
				"t83 topology loads fully offline",
				externalHosts.length === 0,
				externalHosts.join(","),
			);
			check(
				"t83 topology logs zero frame errors",
				artifactBlocks.length === blocksBefore,
				artifactBlocks.slice(blocksBefore).join(" | "),
			);
			// Keep observing past render: our own output must not even
			// attempt an external load.
			await new Promise((r) => setTimeout(r, 2000));
			const spv =
				(await topoFrame?.evaluate(
					() => (window as unknown as { __spv: string[] }).__spv,
				)) ?? null;
			check(
				"t83 topology raises zero csp violations",
				Array.isArray(spv) && spv.length === 0,
				(spv ?? ["no frame"]).join(" | "),
			);
			await page.screenshot({ path: path.join(OUT, "24-t83-topology.png") });
		} finally {
			await page.unroute("**/*");
		}
		// Static scan of the generated file: no external src/href in
		// the markup (scripts stripped first — the mermaid bundle is
		// code, not markup).
		{
			const renderRoot = path.join(t83Ws, "reports", "render");
			let topoSrc = "";
			for (const jd of nodeFs.readdirSync(renderRoot)) {
				const cand = path.join(renderRoot, jd, "topology.html");
				if (nodeFs.existsSync(cand))
					topoSrc = nodeFs.readFileSync(cand, "utf8");
			}
			check("t83 generated topology.html found", topoSrc.length > 0);
			const markup = topoSrc.replace(/<script[\s>][\s\S]*?<\/script\s*>/gi, "");
			const extRefs =
				markup.match(/\b(?:src|href)\s*=\s*["']https?:\/\//gi) ?? [];
			check(
				"t83 topology markup carries no external src/href",
				extRefs.length === 0,
				extRefs.slice(0, 3).join(" | "),
			);
		}
		await openFromTree("probe.html");
		check(
			"t83 probe opens static",
			((await page.locator("#art-tier").textContent()) ?? "") === "static",
		);
		check(
			"t83 live sandbox starts empty",
			(await page.locator("#artframe").getAttribute("sandbox")) === "",
		);
		await artFrame.locator("#t").waitFor({ timeout: 10_000 });
		const before = (await artFrame.locator("#t").textContent()) ?? "";
		check("t83 static tier blocks the inline script", before === "no", before);
		await page.locator("#art-toggle").click();
		await page.waitForFunction(
			() =>
				document.getElementById("art-toggle")?.textContent === "Back to static",
			undefined,
			{ timeout: 10_000 },
		);
		check(
			"t83 toggle opts into the scripts tier",
			((await page.locator("#art-why").textContent()) ?? "").includes(
				"owner opt-in",
			),
		);
		await artFrame.locator("#t").waitFor({ timeout: 10_000 });
		await page.waitForFunction(
			() =>
				document.querySelector("#artframe")?.getAttribute("sandbox") ===
				"allow-scripts",
			undefined,
			{ timeout: 10_000 },
		);
		const after = await artFrame.locator("#t").textContent({ timeout: 10_000 });
		check(
			"t83 run scripts lets the script mutate",
			after === "yes",
			after ?? "",
		);
		check(
			"t83 live sandbox holds only allow-scripts",
			(await page.locator("#artframe").getAttribute("sandbox")) ===
				"allow-scripts",
		);
		await page.screenshot({ path: path.join(OUT, "26-t83-probe-scripts.png") });
		// Navigation cannot be blocked by policy (Chromium has no
		// navigate-to): the UI counts the frame's loads and blanks a
		// navigating artifact with an inline notice. Screenshots 27-28.
		const navHosts: string[] = [];
		await page.route("**/*", async (route) => {
			const host = new URL(route.request().url()).hostname;
			if (host === "127.0.0.1" || host === "localhost") {
				await route.continue();
			} else {
				navHosts.push(host);
				await route.abort();
			}
		});
		try {
			await openFromTree("navaway.html");
			check(
				"t83 nav fixture opens static",
				((await page.locator("#art-tier").textContent()) ?? "") === "static",
			);
			await page.locator("#art-toggle").click();
			let navStopped = false;
			try {
				await page
					.locator("#art-nav")
					.waitFor({ state: "visible", timeout: 10_000 });
				navStopped = true;
			} catch {
				navStopped = false;
			}
			check(
				"t83 navigating artifact is stopped with a notice",
				navStopped &&
					((await page.locator("#art-nav").textContent()) ?? "").includes(
						"tried to navigate away",
					),
			);
			check(
				"t83 stopped frame is blank",
				(await page.locator("#artframe").getAttribute("src")) === "about:blank",
			);
			check(
				"t83 the escape attempt really fired",
				navHosts.includes("example.invalid"),
				navHosts.join(","),
			);
			await page.screenshot({ path: path.join(OUT, "27-t83-navaway.png") });
		} finally {
			await page.unroute("**/*");
		}
		// Each artifact tab keeps its own artifact: pin the first,
		// open the second, reselect the first.
		await openFromTree("first.html");
		const firstTab = page.locator(".ctab.working", {
			has: page.locator(".t", { hasText: "first.html" }),
		});
		await firstTab.locator(".pinbtn").click();
		await openFromTree("second.html");
		check(
			"t83 second artifact binds",
			((await page.locator("#art-title").textContent()) ?? "") ===
				"second.html",
		);
		const firstTabAgain = page.locator(".ctab.working", {
			has: page.locator(".t", { hasText: "first.html" }),
		});
		await firstTabAgain.locator(".t").click();
		await page
			.waitForFunction(
				() =>
					document.getElementById("art-title")?.textContent === "first.html",
				undefined,
				{ timeout: 10_000 },
			)
			.catch(() => {});
		// Reselect rebuilds the frame after its meta fetch too.
		await page.waitForSelector('#artframe[src*="first.html"]', {
			timeout: 10_000,
		});
		check(
			"t83 reselecting the first tab re-binds its header",
			((await page.locator("#art-title").textContent()) ?? "") === "first.html",
		);
		check(
			"t83 reselecting the first tab re-binds its frame",
			((await artFrame.locator("#who").textContent()) ?? "") === "first",
		);
		await page.screenshot({ path: path.join(OUT, "28-t83-tabs.png") });
		await openFromTree("pic.svg");
		await artFrame.locator("svg").first().waitFor({ timeout: 10_000 });
		check(
			"t83 svg displays",
			(await artFrame.locator("#smoke-svg-ok").count()) === 1,
		);
		await openFromTree("dot.png");
		await artFrame.locator("img").first().waitFor({ timeout: 10_000 });
		const pngW = await artFrame
			.locator("img")
			.first()
			.evaluate((img) => (img as HTMLImageElement).naturalWidth);
		check("t83 png displays", pngW === 1, `w=${pngW}`);
		await openFromTree("report.html");
		check(
			"t83 report opens static",
			((await page.locator("#art-tier").textContent()) ?? "") === "static",
		);
		await artFrame.locator("h1").first().waitFor({ timeout: 10_000 });
		const repH1 = (await artFrame.locator("h1").first().textContent()) ?? "";
		check("t83 report renders its heading", repH1 === "Smoke report", repH1);
		await page.screenshot({ path: path.join(OUT, "25-t83-report.png") });
		// Immediate escape: the navigation fires before the
		// artifact's own load completes, so the load counter stays
		// silent (the documented residual) — but the frame's csp
		// attribute refuses to display the destination. The request
		// still goes out: display refusal, not exfiltration
		// prevention. Screenshot 29.
		const refusalsBefore = cspRefusals.length;
		const rootNavs: string[] = [];
		const rootNavListener = (req: Request): void => {
			try {
				const u = new URL(req.url());
				if (
					req.isNavigationRequest() &&
					u.pathname === "/" &&
					(u.hostname === "127.0.0.1" || u.hostname === "localhost")
				) {
					rootNavs.push(req.url());
				}
			} catch {
				// Not a URL; ignore.
			}
		};
		await openFromTree("navnow.html");
		check(
			"t83 immediate-nav fixture opens static",
			((await page.locator("#art-tier").textContent()) ?? "") === "static",
		);
		page.on("request", rootNavListener);
		try {
			await page.locator("#art-toggle").click();
			const t0 = Date.now();
			while (
				cspRefusals.length === refusalsBefore &&
				Date.now() - t0 < 10_000
			) {
				await new Promise((r) => setTimeout(r, 100));
			}
			check(
				"t83 immediate navigation is refused display",
				cspRefusals.length === refusalsBefore + 1,
				cspRefusals.slice(refusalsBefore).join(" | "),
			);
			check(
				"t83 the immediate escape request still fires",
				rootNavs.length >= 1,
				rootNavs.join(","),
			);
			check(
				"t83 immediate-nav destination is not displayed",
				(await artFrame.locator("#chatinput").count()) === 0,
			);
			await page.screenshot({ path: path.join(OUT, "29-t83-navnow.png") });
		} finally {
			page.off("request", rootNavListener);
		}
		check(
			"t83 artifact frame errors are only sandbox/csp blocks",
			artifactBlocks.every(isKnownArtifactBlock),
			artifactBlocks.join(" | "),
		);
		// Expected frame errors come only from the deliberate probe
		// fixtures, named explicitly: probe.html, navaway.html, and
		// navnow.html (static-phase script blocks; the aborted
		// escape itself is console-silent). The navnow refusal lands
		// on the error page, tracked separately in cspRefusals.
		check(
			"t83 frame errors come only from the probe fixtures",
			artifactBlockUrls.every(
				(u) =>
					u.includes("probe.html") ||
					u.includes("navaway.html") ||
					u.includes("navnow.html"),
			),
			artifactBlockUrls.join(" | "),
		);
	} finally {
		await t83Srv.stop();
	}

	// T71: the interruptible stop leg. The fake holds its turn live
	// (never auto-completes), so Stop lands on a live run
	// deterministically — an echo turn (~60ms) cannot be stopped on
	// purpose. The interrupt ack is immediate but its completion waits
	// 2.5s, so the Stopping ticker is screenshottable; the completion
	// then clears Stop with no Force needed.
	const stopA = stubT71Bin();
	await withT71Env(
		stopA.log,
		{ mode: "interruptible", interruptDelayMs: 2500 },
		async () => {
			const srvA = await startServer({
				dataHome: SMOKE_DATA_HOME,
				allowOpenCdb: true,
				workspace: makeWorkspace(),
				provider: "echo",
				museHome: makeHome(),
				toolBinDir: stopA.bin,
			});
			try {
				await page.goto(srvA.url, { waitUntil: "load" });
				const batchA = watchAppBatch(page);
				await page.waitForFunction(
					() =>
						(document.getElementById("set-auth")?.textContent ?? "") !== "…",
					undefined,
					{ timeout: 15_000 },
				);
				await page.fill("#chatinput", "SMOKE-STOPPING");
				await page.click("#sendbtn");
				await page.waitForSelector("#stopbtn:visible", { timeout: 10_000 });
				// The turn is live once the fake logs it (no sleep-flake).
				await pollT71Log(stopA.log, /RECV_TURN/, 15_000);
				await page.click("#stopbtn");
				await page.waitForFunction(
					() =>
						(document.getElementById("stopbtn")?.textContent ?? "").includes(
							"Stopping",
						),
					undefined,
					{ timeout: 10_000 },
				);
				check("stopping ticker shows after Stop", true);
				await page.screenshot({ path: path.join(OUT, "18-t71-stopping.png") });
				await page.waitForFunction(
					() =>
						(document.getElementById("stopbtn") as HTMLButtonElement | null)
							?.style.display === "none",
					undefined,
					{ timeout: 15_000 },
				);
				check(
					"interrupt completion clears Stop without Force",
					(await page.locator("#forcebtn:visible").count()) === 0,
				);
				check(
					"stop note stays hidden on a clean stop",
					(await page.locator("#stopnote:visible").count()) === 0,
				);
				await batchA;
				await page.screenshot({ path: path.join(OUT, "19-t71-stopped.png") });
			} finally {
				await srvA.stop();
			}
		},
	);

	// T71: the stuck-turn leg. The fake acks the interrupt but never
	// completes and ignores stdin EOF (fixture-controlled worker behind
	// the real browser/server/routes): Stop shows the ticker, the 10s
	// timeout reveals Force stop, and forcing SIGTERMs the worker with
	// a step-naming note.
	const stopB = stubT71Bin();
	await withT71Env(stopB.log, { mode: "ignoring" }, async () => {
		const srvB = await startServer({
			dataHome: SMOKE_DATA_HOME,
			allowOpenCdb: true,
			workspace: makeWorkspace(),
			provider: "echo",
			museHome: makeHome(),
			toolBinDir: stopB.bin,
		});
		try {
			await page.goto(srvB.url, { waitUntil: "load" });
			const batchB = watchAppBatch(page);
			await page.waitForFunction(
				() => (document.getElementById("set-auth")?.textContent ?? "") !== "…",
				undefined,
				{ timeout: 15_000 },
			);
			await page.fill("#chatinput", "SMOKE-STUCK");
			await page.click("#sendbtn");
			await page.waitForSelector("#stopbtn:visible", { timeout: 10_000 });
			await pollT71Log(stopB.log, /RECV_TURN/, 15_000);
			await page.click("#stopbtn");
			await page.waitForFunction(
				() =>
					(document.getElementById("stopbtn")?.textContent ?? "").includes(
						"Stopping",
					),
				undefined,
				{ timeout: 10_000 },
			);
			check("stuck turn shows the stopping ticker", true);
			await page.waitForSelector("#forcebtn:visible", { timeout: 20_000 });
			check("force stop appears after the stopping timeout", true);
			await page.screenshot({ path: path.join(OUT, "20-t71-force.png") });
			await page.click("#forcebtn");
			await page.waitForFunction(
				() =>
					(document.getElementById("stopnote")?.textContent ?? "").includes(
						"Stopped via",
					),
				undefined,
				{ timeout: 30_000 },
			);
			const forcedNote = (await page.locator("#stopnote").textContent()) ?? "";
			check(
				"forced stop names the SIGTERM step",
				forcedNote.includes("SIGTERM"),
				forcedNote,
			);
			check(
				"Stop hides once forced",
				(await page.locator("#stopbtn:visible").count()) === 0,
			);
			await batchB;
			await page.screenshot({ path: path.join(OUT, "21-t71-forced-note.png") });
		} finally {
			await srvB.stop();
		}
	});

	// T50: approval/question surface on the scriptable fake. One
	// server, one page flow: the selector shows only Ask first /
	// Allow all (Ask first default); a fake approval renders its
	// choices verbatim and Allow once resolves it; a fake question
	// answers and declines; NEED-BOTH fills the waiting strip and
	// Stop resolves both as interrupt; the settings default persists
	// across reload; a pending approval survives a reload via
	// /api/chat/pending. Screenshots 30-34.
	const t50 = stubT50Bin();
	await withT50Env(t50.log, async () => {
		const srvT = await startServer({
			dataHome: mktmp("ui-smoke-t50-dh-"),
			allowOpenCdb: true,
			workspace: makeWorkspace(),
			provider: "echo",
			museHome: makeHome(),
			toolBinDir: t50.bin,
		});
		try {
			await page.goto(srvT.url, { waitUntil: "load" });
			const batchT = watchAppBatch(page);
			await page.waitForFunction(
				() => (document.getElementById("set-auth")?.textContent ?? "") !== "…",
				undefined,
				{ timeout: 15_000 },
			);
			// Selector: Ask first is the default, and the menu holds
			// only the two honest options, each with its tooltip.
			check(
				"t50 selector defaults to Ask first",
				((await page.locator("#selaccess").textContent()) ?? "").trim() ===
					"Ask first",
			);
			await page.click("#sel-access-btn");
			await page.waitForSelector("#selmenu.open", { timeout: 5_000 });
			const accessOpts = await page.locator("#selmenu .opt").allTextContents();
			check(
				"t50 selector offers only Ask first / Allow all",
				accessOpts.length === 2 &&
					(accessOpts[0] ?? "").includes("Ask first") &&
					(accessOpts[1] ?? "").includes("Allow all"),
				accessOpts.join(" | "),
			);
			const askTip =
				(await page.locator("#selmenu .opt").nth(0).getAttribute("title")) ??
				"";
			const allowTip =
				(await page.locator("#selmenu .opt").nth(1).getAttribute("title")) ??
				"";
			check(
				"t50 Ask first tooltip is honest",
				askTip.includes("ask before they run"),
				askTip,
			);
			check(
				"t50 Allow all tooltip is honest",
				allowTip.toLowerCase().includes("nothing asks"),
				allowTip,
			);
			await page.screenshot({ path: path.join(OUT, "30-t50-selector.png") });
			await page.keyboard.press("Escape");
			// Approval: the card renders the captured choices verbatim,
			// the waiting strip counts it, Allow once resolves it.
			await page.fill("#chatinput", "NEED-APPROVAL smoke ls");
			await page.click("#sendbtn");
			await page.waitForSelector(".appr-card.hold-pending", {
				timeout: 15_000,
			});
			const apprBtns = await page
				.locator(".appr-card.hold-pending .appr-btn")
				.allTextContents();
			check(
				"t50 approval card renders choices verbatim",
				apprBtns.length === 3 &&
					(apprBtns[0] ?? "").includes("Allow once") &&
					(apprBtns[1] ?? "").includes(
						"Always allow in this workspace: ls ...",
					) &&
					(apprBtns[2] ?? "").includes("Reject"),
				apprBtns.join(" | "),
			);
			// The live meta sends identical label/rulePreview strings for
			// allow_local_prefix: the subtitle hides instead of doubling.
			const allowLocalBtn = page
				.locator(
					'.appr-card.hold-pending .appr-btn[data-choice="allow_local_prefix"]',
				)
				.first();
			const allowLocalText = (await allowLocalBtn.textContent()) ?? "";
			const labelNeedle = "Always allow in this workspace: ls ...";
			check(
				"t50 rulePreview hides when it equals the label",
				allowLocalText.split(labelNeedle).length - 1 === 1,
				allowLocalText,
			);
			check(
				"t50 equal rulePreview leaves no subtitle node",
				(await allowLocalBtn.locator(".rule").count()) === 0,
			);
			const apprText =
				(await page.locator(".appr-card.hold-pending").first().textContent()) ??
				"";
			check(
				"t50 approval card shows the shell command",
				apprText.includes("ls -1"),
				apprText.slice(0, 200),
			);
			await page.waitForSelector("#waiting:visible", { timeout: 5_000 });
			const waiting1 = (
				(await page.locator("#waiting").textContent()) ?? ""
			).replace(/\s+/g, " ");
			check(
				"t50 waiting strip counts the approval",
				waiting1.includes("Waiting for you") && waiting1.includes("1"),
				waiting1,
			);
			await page.screenshot({ path: path.join(OUT, "31-t50-approval.png") });
			await page
				.locator('.appr-card.hold-pending .appr-btn[data-choice="allow_once"]')
				.first()
				.click();
			await page.waitForSelector(".appr-card.hold-resolved .appr-resolved", {
				timeout: 15_000,
			});
			const apprDone =
				(await page
					.locator(".appr-card.hold-resolved .appr-resolved")
					.first()
					.textContent()) ?? "";
			check(
				"t50 Allow once resolves the card",
				apprDone.includes("approved") && apprDone.includes("user"),
				apprDone,
			);
			check(
				"t50 waiting strip clears after decide",
				(await page.locator("#waiting:visible").count()) === 0,
			);
			await pollT71Log(
				t50.log,
				/DECIDE approvalId=t50-a1 choiceId=allow_once/,
				15_000,
			);
			await page.waitForSelector("#sendbtn:visible", { timeout: 15_000 });
			// Question: options render, Tabs answers, a second prompt declines.
			await page.fill("#chatinput", "NEED-QUESTION smoke indent");
			await page.click("#sendbtn");
			await page.waitForSelector(".q-card.hold-pending", { timeout: 15_000 });
			const qOpts = await page
				.locator(".q-card.hold-pending .q-opt")
				.allTextContents();
			check(
				"t50 question card renders options verbatim",
				qOpts.length === 2 &&
					(qOpts[0] ?? "").includes("Tabs") &&
					(qOpts[1] ?? "").includes("Spaces"),
				qOpts.join(" | "),
			);
			check(
				"t50 question card offers Decline",
				(await page.locator(".q-card.hold-pending .q-decline").count()) === 1,
			);
			await page.screenshot({ path: path.join(OUT, "32-t50-question.png") });
			await page
				.locator('.q-card.hold-pending .q-opt[data-label="Tabs"]')
				.first()
				.click();
			await page.locator(".q-card.hold-pending .q-answer").first().click();
			await page.waitForSelector(".q-card.hold-resolved .q-resolved", {
				timeout: 15_000,
			});
			const qDone =
				(await page
					.locator(".q-card.hold-resolved .q-resolved")
					.first()
					.textContent()) ?? "";
			check("t50 answer resolves the card", qDone.includes("answered"), qDone);
			await pollT71Log(t50.log, /ANSWER userInputId=t50-q1/, 15_000);
			await page.waitForSelector("#sendbtn:visible", { timeout: 15_000 });
			await page.fill("#chatinput", "NEED-QUESTION smoke decline");
			await page.click("#sendbtn");
			await page.waitForSelector(".q-card.hold-pending", { timeout: 15_000 });
			await page.locator(".q-card.hold-pending .q-decline").first().click();
			await page.waitForFunction(
				() =>
					[
						...document.querySelectorAll(".q-card.hold-resolved .q-resolved"),
					].some((el) => (el.textContent ?? "").includes("cancelled")),
				undefined,
				{ timeout: 15_000 },
			);
			check("t50 Decline cancels the prompt", true);
			await pollT71Log(t50.log, /CANCEL userInputId=t50-q2/, 15_000);
			await page.waitForSelector("#sendbtn:visible", { timeout: 15_000 });
			// Waiting strip + interrupt: NEED-BOTH counts 2, a strip
			// click scrolls to the card, Stop resolves both as interrupt.
			await page.fill("#chatinput", "NEED-BOTH smoke both");
			await page.click("#sendbtn");
			await page.waitForFunction(
				() =>
					(document.getElementById("waiting")?.textContent ?? "").includes("2"),
				undefined,
				{ timeout: 15_000 },
			);
			const waiting2 = (
				(await page.locator("#waiting").textContent()) ?? ""
			).replace(/\s+/g, " ");
			check(
				"t50 waiting strip counts both holds",
				waiting2.includes("2"),
				waiting2,
			);
			await page.screenshot({ path: path.join(OUT, "33-t50-waiting.png") });
			await page.click("#waiting");
			const firstPendingVisible = await page.evaluate(() => {
				const el = document.querySelector(
					".appr-card.hold-pending, .q-card.hold-pending",
				);
				if (!el) return false;
				const r = el.getBoundingClientRect();
				return r.top >= 0 && r.bottom <= window.innerHeight;
			});
			check("t50 waiting click scrolls to the card", firstPendingVisible);
			await page.click("#stopbtn");
			await page.waitForFunction(
				() =>
					[
						...document.querySelectorAll(
							".appr-card.hold-resolved .appr-resolved",
						),
					].some((el) => /interrupt/i.test(el.textContent ?? "")) &&
					[
						...document.querySelectorAll(".q-card.hold-resolved .q-resolved"),
					].some((el) => /interrupt/i.test(el.textContent ?? "")),
				undefined,
				{ timeout: 15_000 },
			);
			check("t50 Stop resolves both cards as interrupt", true);
			check(
				"t50 waiting strip clears after interrupt",
				(await page.locator("#waiting:visible").count()) === 0,
			);
			await page.waitForSelector("#sendbtn:visible", { timeout: 15_000 });
			// Settings default: the row writes through and persists.
			await page.click('#crail button[data-crview="rview-settings"]');
			await page.waitForSelector("#set-defaccess", { timeout: 5_000 });
			check(
				"t50 settings default starts at Ask first",
				((await page.locator("#set-defaccess").textContent()) ?? "").trim() ===
					"Ask first",
			);
			await page
				.locator('#defaccess-btns button[data-defaccess="allowAll"]')
				.click();
			await page.waitForFunction(
				() =>
					(
						document.getElementById("set-defaccess")?.textContent ?? ""
					).includes("Allow all"),
				undefined,
				{ timeout: 5_000 },
			);
			check("t50 settings default writes through", true);
			await page.screenshot({ path: path.join(OUT, "34-t50-settings.png") });
			await page.reload({ waitUntil: "load" });
			await page.waitForFunction(
				() => (document.getElementById("set-auth")?.textContent ?? "") !== "…",
				undefined,
				{ timeout: 15_000 },
			);
			await page.click('#crail button[data-crview="rview-settings"]');
			check(
				"t50 settings default persists across reload",
				((await page.locator("#set-defaccess").textContent()) ?? "").trim() ===
					"Allow all",
			);
			// Late join: a pending approval survives the reload above and
			// re-renders from /api/chat/pending (it was never decided).
			await page.fill("#chatinput", "NEED-APPROVAL smoke late");
			await page.click("#sendbtn");
			await page.waitForSelector(".appr-card.hold-pending", {
				timeout: 15_000,
			});
			const lateId =
				(await page
					.locator(".appr-card.hold-pending")
					.first()
					.getAttribute("data-approval")) ?? "";
			await page.reload({ waitUntil: "load" });
			await page.waitForFunction(
				() => (document.getElementById("set-auth")?.textContent ?? "") !== "…",
				undefined,
				{ timeout: 15_000 },
			);
			await page.waitForSelector(
				`.appr-card.hold-pending[data-approval="${lateId}"]`,
				{
					timeout: 15_000,
				},
			);
			check("t50 pending approval survives reload", lateId !== "");
			await page
				.locator(
					`.appr-card.hold-pending[data-approval="${lateId}"] .appr-btn[data-choice="abort"]`,
				)
				.click();
			await page.waitForFunction(
				(id) =>
					[...document.querySelectorAll(".appr-card.hold-resolved")].some(
						(el) =>
							el.getAttribute("data-approval") === id &&
							(el.querySelector(".appr-resolved")?.textContent ?? "").includes(
								"abort",
							),
					),
				lateId,
				{ timeout: 15_000 },
			);
			check("t50 Reject after reload resolves as abort", true);
			// T49 targeting: the smoke-gw card targets into a pill,
			// the pill travels with the send, the sent bubble shows
			// a chip (never the raw preamble), and the fake's turn
			// input carries the validated context line.
			await page.locator('.dev[data-key="dev-smoke-gw"]').click();
			await page.waitForSelector("#pdev-add:visible", { timeout: 10_000 });
			await page.click("#pdev-add");
			await page.waitForSelector('.tpill[data-dev="smoke-gw"]', {
				timeout: 5_000,
			});
			await page.fill("#chatinput", "T49-TARGET-PROBE");
			await page.click("#sendbtn");
			await page.waitForFunction(
				() =>
					[...document.querySelectorAll("#pane-chat .msg.agent .body p")].some(
						(p) => (p.textContent ?? "").includes("t50 done"),
					),
				undefined,
				{ timeout: 30_000 },
			);
			const chipTexts = await page
				.locator("#pane-chat .msg.user .tchip")
				.allTextContents();
			check(
				"t49 sent bubble shows the target chip",
				chipTexts.some((t) => t.includes("smoke-gw")),
				chipTexts.join(" | ") || "(no chips)",
			);
			const domLeak = await page.evaluate(() =>
				(document.body.textContent ?? "").includes("[routeros-muse context]"),
			);
			check("t49 raw preamble never renders in the DOM", domLeak === false);
			const t49Turns = nodeFs
				.readFileSync(t50.log, "utf8")
				.split("\n")
				.filter((l) => l.startsWith("TURN_TEXT "))
				.map((l) => JSON.parse(l.slice("TURN_TEXT ".length)) as string);
			const t49Turn =
				t49Turns.find((t) => t.includes("T49-TARGET-PROBE")) ?? "";
			check(
				"t49 fake turn input carries the validated preamble",
				t49Turn.startsWith(
					"[routeros-muse context] target device: smoke-gw (id smoke-gw)\n\nT49-TARGET-PROBE",
				),
				t49Turn.slice(0, 160),
			);
			await page.screenshot({ path: path.join(OUT, "40-t49-target.png") });
			// The two reloads above fired fresh app batches after
			// batchT resolved: prove quiescence before the stop.
			await page.evaluate(async () => {
				await Promise.all(
					["/api/chat/models", "/api/past", "/api/chat/history"].map((p) =>
						fetch(p),
					),
				);
			});
			await batchT;
		} finally {
			await srvT.stop();
		}
	});

	// T50 follow-up: first-connect recovery, settled-elsewhere
	// reconcile, and a differing rulePreview — on a second
	// fake-backed server with two tabs (one context) on one session.
	// Screenshots 35-37. The behavior-under-test waits are soft
	// (timeout becomes a FAIL line, not a thrown abort) so one run
	// shows every new leg red before the fix and green after.
	const t50b = stubT50Bin();
	await withT50Env(t50b.log, async () => {
		const srvU = await startServer({
			dataHome: mktmp("ui-smoke-t50u-dh-"),
			allowOpenCdb: true,
			workspace: makeWorkspace(),
			provider: "echo",
			museHome: makeHome(),
			toolBinDir: t50b.bin,
		});
		try {
			const ctxU = await browser.newContext({
				viewport: { width: 1600, height: 900 },
			});
			const pageF = await ctxU.newPage();
			const pageG = await ctxU.newPage();
			// R2 aborts F's SSE at the route: Chromium logs the failed
			// EventSource request. Excused only for that exact shape on
			// the events endpoint (location-scoped, like the artifact
			// blocks) — any other console error still fails the gate.
			const sseAbortNoise: string[] = [];
			for (const p of [pageF, pageG]) {
				p.on("console", (msg) => {
					if (msg.type() !== "error") return;
					const text = msg.text().slice(0, 300);
					if (
						msg.location().url.includes("/api/chat/events") &&
						text.includes("net::ERR_FAILED")
					) {
						sseAbortNoise.push(text);
						return;
					}
					consoleErrors.push(text);
				});
				p.on("response", (res) => {
					if (res.status() >= 400) {
						const req = res.request();
						failedResponses.push({
							status: res.status(),
							method: req.method(),
							pathname: new URL(req.url()).pathname,
						});
					}
				});
				p.on("pageerror", (err) =>
					pageErrors.push(`pageerror: ${String(err).slice(0, 300)}`),
				);
			}
			const soft = async (fn: () => Promise<unknown>): Promise<boolean> => {
				try {
					await fn();
					return true;
				} catch {
					return false;
				}
			};
			// Leg F1 (first-connect gap): SSE held at the route while
			// the initial pending fetch completes; the fake then emits
			// an approval no path has seen; releasing SSE must render
			// the card plus the waiting strip via first-onopen recovery.
			let sseMode: "hold" | "live" | "abort" = "hold";
			let releaseHold: () => void = () => {};
			const holdGate = new Promise<void>((resolve) => {
				releaseHold = resolve;
			});
			await pageF.route("**/api/chat/events", async (route) => {
				if (sseMode === "abort") {
					await route.abort();
					return;
				}
				if (sseMode === "hold") await holdGate;
				await route.continue();
			});
			const batchF = watchAppBatch(pageF);
			const pendingFirst = pageF.waitForResponse(
				(r) => new URL(r.url()).pathname === "/api/chat/pending",
				{ timeout: 30_000 },
			);
			await pageF.goto(srvU.url, { waitUntil: "load" });
			await pageF.waitForFunction(
				() => (document.getElementById("set-auth")?.textContent ?? "") !== "…",
				undefined,
				{ timeout: 15_000 },
			);
			await pendingFirst;
			await pageF.fill("#chatinput", "NEED-APPROVAL first-connect gap");
			await pageF.click("#sendbtn");
			await pollT71Log(t50b.log, /EMIT-APPROVAL/, 15_000);
			check(
				"t50 held SSE shows no card before release",
				(await pageF.locator(".appr-card.hold-pending").count()) === 0,
			);
			sseMode = "live";
			releaseHold();
			check(
				"t50 first-connect recovery renders the held approval",
				await soft(() =>
					pageF.waitForSelector(".appr-card.hold-pending", {
						timeout: 15_000,
					}),
				),
			);
			const waitingF = (
				(await pageF.locator("#waiting").textContent()) ?? ""
			).replace(/\s+/g, " ");
			check(
				"t50 waiting strip appears after first-connect recovery",
				waitingF.includes("Waiting for you") && waitingF.includes("1"),
				waitingF,
			);
			await pageF.screenshot({
				path: path.join(OUT, "35-t50-firstconnect.png"),
			});
			// Recoveries never overlap (sol re-review: out-of-order
			// snapshots settled live prompts). Three concurrent asks with
			// a slow server: one request at a time, coalesced to two.
			{
				const isPending = (u: string) =>
					new URL(u).pathname === "/api/chat/pending";
				let inflight = 0;
				let maxInflight = 0;
				let requests = 0;
				const onReq = (r: { url: () => string }) => {
					if (!isPending(r.url())) return;
					requests += 1;
					inflight += 1;
					maxInflight = Math.max(maxInflight, inflight);
				};
				const onDone = (r: { url: () => string }) => {
					if (isPending(r.url())) inflight -= 1;
				};
				pageF.on("request", onReq);
				pageF.on("requestfinished", onDone);
				pageF.on("requestfailed", onDone);
				await pageF.route("**/api/chat/pending", async (route) => {
					await new Promise((r) => setTimeout(r, 300));
					await route.continue();
				});
				await pageF.evaluate(() =>
					Promise.all([1, 2, 3].map(() => window.__smoke?.recoverPending())),
				);
				await pageF.unroute("**/api/chat/pending");
				pageF.off("request", onReq);
				pageF.off("requestfinished", onDone);
				pageF.off("requestfailed", onDone);
				check(
					"t50 recoveries never overlap",
					maxInflight === 1,
					`max in flight ${maxInflight}`,
				);
				check(
					"t50 concurrent recoveries coalesce to one re-run",
					requests === 2,
					`requests ${requests}`,
				);
			}
			// Converge F1's approval before R2: decide its card when one
			// rendered, else Stop the still-held turn — either way t50-a1
			// settles server-side and F idles, so R2 starts clean.
			if ((await pageF.locator(".appr-card.hold-pending").count()) > 0) {
				await pageF
					.locator(
						'.appr-card.hold-pending .appr-btn[data-choice="allow_once"]',
					)
					.first()
					.click();
				await pageF.waitForSelector(".appr-card.hold-resolved .appr-resolved", {
					timeout: 15_000,
				});
			}
			if ((await pageF.locator("#stopbtn:visible").count()) > 0) {
				await pageF.click("#stopbtn");
				await pageF.waitForSelector("#sendbtn:visible", { timeout: 15_000 });
			}
			await pollT71Log(
				t50b.log,
				/(DECIDE approvalId=t50-a1|INTERRUPT-RESOLVED approvalId=t50-a1)/,
				15_000,
			);
			// Leg R2 (settled elsewhere): F holds a pending approval,
			// drops SSE (abort + reload re-renders from the snapshot),
			// G decides it, F's next recovery reconciles the card away.
			await pageF.fill("#chatinput", "NEED-APPROVAL settle elsewhere");
			await pageF.click("#sendbtn");
			await pageF.waitForSelector(".appr-card.hold-pending", {
				timeout: 15_000,
			});
			const batchG = watchAppBatch(pageG);
			await pageG.goto(srvU.url, { waitUntil: "load" });
			await pageG.waitForFunction(
				() => (document.getElementById("set-auth")?.textContent ?? "") !== "…",
				undefined,
				{ timeout: 15_000 },
			);
			await pageG.waitForSelector(".appr-card.hold-pending", {
				timeout: 15_000,
			});
			sseMode = "abort";
			await pageF.reload({ waitUntil: "load" });
			await pageF.waitForFunction(
				() => (document.getElementById("set-auth")?.textContent ?? "") !== "…",
				undefined,
				{ timeout: 15_000 },
			);
			await pageF.waitForSelector(".appr-card.hold-pending", {
				timeout: 15_000,
			});
			await pageF.waitForSelector("#ssestate:visible", { timeout: 15_000 });
			check("t50 offline tab keeps its pending card", true);
			await pageG
				.locator('.appr-card.hold-pending .appr-btn[data-choice="allow_once"]')
				.first()
				.click();
			await pageG.waitForSelector(".appr-card.hold-resolved .appr-resolved", {
				timeout: 15_000,
			});
			await pollT71Log(t50b.log, /DECIDE approvalId=t50-a2/, 15_000);
			sseMode = "live";
			check(
				"t50 reconnect marks the prompt settled elsewhere",
				await soft(() =>
					pageF.waitForFunction(
						() =>
							[
								...document.querySelectorAll(
									".appr-card.hold-resolved .appr-resolved",
								),
							].some((el) =>
								(el.textContent ?? "").includes("settled elsewhere"),
							),
						undefined,
						{ timeout: 15_000 },
					),
				),
			);
			check(
				"t50 settled-elsewhere tab holds no pending card",
				(await pageF.locator(".appr-card.hold-pending").count()) === 0,
			);
			check(
				"t50 waiting strip clears after settled-elsewhere reconcile",
				(await pageF.locator("#waiting:visible").count()) === 0,
			);
			check(
				"t50 offline phase really dropped SSE requests",
				sseAbortNoise.length >= 1,
				`aborts=${sseAbortNoise.length}`,
			);
			await pageF.screenshot({
				path: path.join(OUT, "36-t50-elsewhere.png"),
			});
			// Leg D6 (differing rulePreview): the subtitle stays when it
			// differs from the label — the pending snapshot is rewritten
			// on the way in, so the card renders the different text. Runs
			// on G, the tab that stayed connected through R2.
			await pageG.fill("#chatinput", "NEED-APPROVAL rule differs");
			await pageG.click("#sendbtn");
			await pageG.waitForSelector(".appr-card.hold-pending", {
				timeout: 15_000,
			});
			const DIFF_RULE = "rule: ls anywhere below the workspace";
			await pageG.route("**/api/chat/pending", async (route) => {
				const resp = await route.fetch();
				const j = (await resp.json()) as {
					approvals?: {
						availableChoices?: { choiceId?: string; rulePreview?: string }[];
					}[];
				};
				for (const a of j.approvals ?? []) {
					for (const c of a.availableChoices ?? []) {
						if (c.choiceId === "allow_local_prefix") c.rulePreview = DIFF_RULE;
					}
				}
				await route.fulfill({ response: resp, json: j });
			});
			await pageG.reload({ waitUntil: "load" });
			await pageG.waitForFunction(
				() => (document.getElementById("set-auth")?.textContent ?? "") !== "…",
				undefined,
				{ timeout: 15_000 },
			);
			await pageG.waitForSelector(".appr-card.hold-pending", {
				timeout: 15_000,
			});
			const diffRule = pageG
				.locator(
					'.appr-card.hold-pending .appr-btn[data-choice="allow_local_prefix"] .rule',
				)
				.first();
			check(
				"t50 rulePreview shows when it differs from the label",
				(await diffRule.count()) === 1 &&
					((await diffRule.textContent()) ?? "") === DIFF_RULE,
				(await diffRule.textContent()) ?? "(no subtitle)",
			);
			await pageG.screenshot({ path: path.join(OUT, "37-t50-rulediff.png") });
			await pageG.unroute("**/api/chat/pending");
			await pageG
				.locator('.appr-card.hold-pending .appr-btn[data-choice="abort"]')
				.first()
				.click();
			await pageG.waitForSelector(".appr-card.hold-resolved .appr-resolved", {
				timeout: 15_000,
			});
			// Quiescence before the stop (mirrors the T50 block): the
			// reloads above fired fresh app batches after batchF/batchG
			// resolved, so round-trip first, then await the waiters.
			await pageF.evaluate(async () => {
				await Promise.all(
					["/api/chat/models", "/api/past", "/api/chat/history"].map((p) =>
						fetch(p),
					),
				);
			});
			await pageG.evaluate(async () => {
				await Promise.all(
					["/api/chat/models", "/api/past", "/api/chat/history"].map((p) =>
						fetch(p),
					),
				);
			});
			await batchF;
			await batchG;
			await ctxU.close();
		} finally {
			await srvU.stop();
		}
	});

	// T89: expected-error exceptions are route-specific. The four
	// deliberate failures (each leg asserts its own honest UI above):
	// - fake-ref open-in-tab: GET /api/chat/output -> 400 (MspError)
	// - wrong-password unlock: POST /api/auth/unlock -> 401
	// - bad scaffold name (T40 picker leg): POST /api/workspaces -> 400
	// - raced credential save (T72 leg a): POST credentials -> 409
	// Query strings are ignored in the path match (the fake ref carries
	// query params); match on pathname only.
	const EXPECTED_FAILED: FailedResponse[] = [
		{ status: 400, method: "GET", pathname: "/api/chat/output" },
		{ status: 401, method: "POST", pathname: "/api/auth/unlock" },
		{ status: 400, method: "POST", pathname: "/api/workspaces" },
		{
			status: 409,
			method: "POST",
			pathname: "/api/devices/smoke-gw/credentials",
		},
	];
	const failedKey = (f: FailedResponse): string =>
		`${f.status} ${f.method} ${f.pathname}`;
	const expectedKeys = EXPECTED_FAILED.map(failedKey).sort();
	const actualKeys = failedResponses.map(failedKey).sort();
	const sawFailed = (want: FailedResponse): boolean =>
		failedResponses.some(
			(f) =>
				f.status === want.status &&
				f.method === want.method &&
				f.pathname === want.pathname,
		);
	check(
		"expected 400 surfaces for the fake ref",
		sawFailed({ status: 400, method: "GET", pathname: "/api/chat/output" }),
		`got [${actualKeys.join(", ")}]`,
	);
	check(
		"expected 401 surfaces for the wrong password",
		sawFailed({ status: 401, method: "POST", pathname: "/api/auth/unlock" }),
		`got [${actualKeys.join(", ")}]`,
	);
	check(
		"expected 409 surfaces for the raced credential save",
		sawFailed({
			status: 409,
			method: "POST",
			pathname: "/api/devices/smoke-gw/credentials",
		}),
		`got [${actualKeys.join(", ")}]`,
	);
	check(
		"failed responses are exactly the expected routes",
		expectedKeys.length === actualKeys.length &&
			expectedKeys.every((k, i) => k === actualKeys[i]),
		`expected [${expectedKeys.join(", ")}] got [${actualKeys.join(", ")}]`,
	);
	// Every console error must be Chrome's failed-resource shape for an
	// expected status: the exact prefix from an observed run, and the
	// status code as a word-boundary token, never a substring.
	const RESOURCE_PREFIX =
		"Failed to load resource: the server responded with a status of ";
	const resourceStatus = (e: string): number | null => {
		if (!e.startsWith(RESOURCE_PREFIX)) return null;
		const m = /^(\d+)\b/.exec(e.slice(RESOURCE_PREFIX.length));
		if (m === null || m[1] === undefined) return null;
		return Number(m[1]);
	};
	const expectedStatuses = EXPECTED_FAILED.map((f) => f.status);
	const unexpectedConsole = consoleErrors.filter(
		(e) =>
			!expectedStatuses.includes(resourceStatus(e) ?? -1) &&
			!(artifactBlocks.includes(e) && isKnownArtifactBlock(e)) &&
			!cspRefusals.includes(e),
	);
	check(
		"console errors are only the expected resource loads",
		unexpectedConsole.length === 0,
		unexpectedConsole.join(" | "),
	);
	// Reconciliation is self-consistent, not hardcoded: per-status
	// console counts must equal per-status expected-response counts.
	for (const status of new Set(expectedStatuses)) {
		const want = expectedStatuses.filter((s) => s === status).length;
		const got = consoleErrors.filter(
			(e) => resourceStatus(e) === status,
		).length;
		check(
			`console ${status}s reconcile with expected ${status} responses`,
			got === want,
			`console=${got} expected=${want}`,
		);
	}
	check("zero pageerrors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
	await browser.close();
	await srv.stop();
	// T94: every smoke tmpdir (works, homes, picker, CDB seed, T71 bins)
	// funnels through the shared registry; one drain covers all legs.
	cleanupTmpdirs();
}

console.log(
	failures.length === 0
		? `\nSMOKE GREEN — shots in ${OUT}`
		: `\nSMOKE RED (${failures.length}): ${failures.join(", ")} — shots in ${OUT}`,
);
process.exit(failures.length === 0 ? 0 : 1);
