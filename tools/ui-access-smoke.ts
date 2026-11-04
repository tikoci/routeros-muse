// Focused real-server Access sweep; the full smoke also retains its Access legs.
import { expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium } from "playwright";
import { startServer } from "../src/serve/server";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "muse-access-ui-"));
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, "workspace.toml"), "canonical = true\n");
const home = path.join(root, "home");
fs.mkdirSync(path.join(home, "muse", "model-catalog"), { recursive: true });
for (const f of fs.readdirSync("tests/fixtures/model-catalog"))
	fs.copyFileSync(
		path.join("tests/fixtures/model-catalog", f),
		path.join(home, "muse", "model-catalog", f),
	);
const cdb = path.join(workspace, "device.cdb");
for (const args of [
	["init"],
	[
		"add",
		"192.0.2.10",
		"--user",
		"probe",
		"--password",
		"synthetic-secret",
		"--profile",
		"field",
		"--session",
		"lab",
		"--group",
		"routers",
		"via=ssh",
		"timeout=5000",
		"ssh-key=/tmp/my-key",
		"identity=edge",
		"mcp=ro",
	],
]) {
	const result = Bun.spawnSync([
		"centrs",
		"devices",
		...args,
		"--cdb-file",
		cdb,
		"--json",
	]);
	if (result.exitCode) throw new Error(result.stderr.toString());
}
const srv = await startServer({
	workspace,
	provider: "echo",
	allowOpenCdb: true,
	museHome: home,
	dataHome: path.join(root, "data"),
	configHome: path.join(root, "config"),
});
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (msg) => {
	if (msg.type() !== "error") return;
	if (
		msg.location().url.endsWith("/api/devices/192.0.2.10/credentials") &&
		msg.text().includes("409")
	)
		return;
	errors.push(msg.text());
});

const out = path.resolve("out/ui-smoke");
fs.mkdirSync(out, { recursive: true });
try {
	await page.goto(srv.url, { waitUntil: "load" });
	await page.waitForSelector("#devlist .dev");
	await page.evaluate("openCred('192.0.2.10')");
	await page.waitForFunction(() =>
		document.getElementById("credctx")?.textContent?.includes("user probe"),
	);
	expect(await page.locator("#credf-profile").inputValue()).toBe("field");
	expect(await page.locator("#credf-password").inputValue()).toBe("");
	expect(await page.locator("#credsaved").isVisible()).toBe(true);
	expect(await page.locator(".credsection[open]").count()).toBe(0);
	for (const theme of ["dark", "light"]) {
		await page.evaluate(
			(t) => (document.documentElement.dataset["theme"] = t),
			theme,
		);
		await page.screenshot({ path: path.join(out, `access-set-${theme}.png`) });
		await page.locator(".credsection summary").first().click();
		await page.screenshot({
			path: path.join(out, `access-connection-${theme}.png`),
		});
		await page.locator(".credsection summary").first().click();
	}
	// Diff-only submit: no unchanged credentials or metadata ride this POST.
	await page.fill("#credf-password", "synthetic-replacement");
	const post = page.waitForRequest(
		(r) => r.method() === "POST" && r.url().endsWith("/credentials"),
	);
	await page.click("#credsave");
	const sent = (await post).postDataJSON();
	expect(Object.keys(sent).sort()).toEqual([
		"attributes",
		"expected",
		"password",
		"ports",
	]);
	await page.waitForSelector("#credmodal.open", { state: "hidden" });
	expect(await page.locator("#credf-password").inputValue()).toBe("");
	await page.waitForFunction(
		() => !(document.getElementById("credsave") as HTMLButtonElement).disabled,
	);
	// T72: held POST proves double-submit and busy-close guards, then a conflict retains input.
	await page.evaluate("openCred('192.0.2.10')");
	await page.waitForFunction(() =>
		document.getElementById("credctx")?.textContent?.includes("user probe"),
	);
	const current = await page.evaluate(
		async () =>
			(await (await fetch("/api/devices/192.0.2.10/credentials")).json())
				.details,
	);
	let release: (() => void) | undefined;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let posts = 0;
	await page.route("**/api/devices/192.0.2.10/credentials", async (route) => {
		if (route.request().method() !== "POST") return route.continue();
		posts++;
		await held;
		await route.fulfill({
			status: 409,
			contentType: "application/json",
			body: JSON.stringify({
				ok: false,
				conflict: true,
				current: { ...current, group: "updated" },
				why: "record for 192.0.2.10 changed while the modal was open; review it before writing",
			}),
		});
	});
	await page.fill("#credf-password", "retain-on-conflict");
	await page.evaluate(() => {
		const form = document.getElementById("credform") as HTMLFormElement;
		form.requestSubmit();
		form.requestSubmit();
	});
	await page.waitForFunction(
		() => (document.getElementById("credsave") as HTMLButtonElement).disabled,
	);
	await page.keyboard.press("Escape");
	expect(await page.locator("#credmodal.open").count()).toBe(1);
	expect(await page.locator("#credcancel").isDisabled()).toBe(true);
	expect(posts).toBe(1);
	if (!release) throw new Error("missing held POST release");
	release();
	await page.waitForFunction(
		() => !(document.getElementById("credsave") as HTMLButtonElement).disabled,
	);
	expect(await page.locator("#credf-password").inputValue()).toBe(
		"retain-on-conflict",
	);
	expect(await page.locator("#crederr").textContent()).toContain(
		"changed while the modal was open",
	);
	await page.unroute("**/api/devices/192.0.2.10/credentials");
	await page.click("#credcancel");
	await page.evaluate("openAddDevice('', '', '')");
	for (const theme of ["dark", "light"]) {
		await page.evaluate(
			(t) => (document.documentElement.dataset["theme"] = t),
			theme,
		);
		await page.screenshot({ path: path.join(out, `access-add-${theme}.png`) });
	}
	expect(await page.locator("#credf-recordTypeName").isEnabled()).toBe(true);
	await page.fill("#credf-host", "192.0.2.11");
	await page.fill("#credf-user", "probe");
	await page.fill("#credf-password", "synthetic-add");
	await page.click("#credsave");
	await page.waitForSelector("#credmodal.open", { state: "hidden" });
	await page.waitForSelector('.dev[data-key="dev-192.0.2.11"]');
	expect(await page.locator('.dev[data-key="dev-192.0.2.11"]').count()).toBe(1);
	expect(errors).toEqual([]);
	console.log(
		"PASS Access browser sweep: set/add, dark/light, collapsed/expanded, diff-only save, password redaction, clear-on-success, busy-close/double-submit guards, conflict retention, console clean (15 assertions)",
	);
} finally {
	await browser.close();
	await srv.stop();
	fs.rmSync(root, { recursive: true, force: true });
}
