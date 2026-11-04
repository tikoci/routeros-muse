// T167: exercise the real panel with controlled quickchr snapshots.
import assert from "node:assert/strict";
import type { Page } from "playwright";

export async function checkTwinsRefresh(page: Page, out: string) {
	const consoleErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() !== "error") return;
		// The app's empty sandboxed artifact frames produce this expected
		// Chromium notice (the whole-app smoke checks the same boundary).
		if (
			message.text() ===
			"Blocked script execution in 'about:blank' because the document's frame is sandboxed and the 'allow-scripts' permission is not set."
		)
			return;
		if (
			message.location().url.endsWith("/api/twins") &&
			message.text().includes("net::ERR_FAILED")
		)
			return;
		consoleErrors.push(message.text());
	});
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(String(error)));
	let calls = 0;
	let mode = "running";
	let release: (() => void) | undefined;
	await page.route("**/api/twins", async (route) => {
		calls++;
		if (mode === "held")
			await new Promise<void>((r) => {
				release = r;
			});
		if (mode === "failed") return route.abort();
		await route.fulfill({
			json:
				mode === "unavailable"
					? { available: false, why: "quickchr unavailable" }
					: {
							available: true,
							twins: [
								{
									name: "refresh-test",
									status: mode,
									version: "7.25.1",
									ports: { http: { host: 9180, guest: 80 } },
								},
							],
						},
		});
	});
	await page.clock.install();
	await page.locator('[data-crview="rview-twins"]').click();
	const ready = () =>
		page.waitForFunction(
			() =>
				document.querySelector<HTMLButtonElement>("#twinsrefresh")?.disabled ===
				false,
		);
	await ready();
	assert.equal(await page.locator("#qc-running").textContent(), "1");
	assert.equal(
		await page.locator("#twinlist .webfig").getAttribute("href"),
		"http://127.0.0.1:9180/webfig/",
	);
	assert.equal(
		await page.locator("#twinlist .webfig").getAttribute("target"),
		"_blank",
	);
	mode = "stopped";
	await page.locator("#twinsrefresh").click();
	await ready();
	assert.equal(await page.locator("#qc-running").textContent(), "0");
	assert.equal(await page.locator("#twinbadge").textContent(), "0/1");
	assert.equal(await page.locator("#twinlist .webfig").count(), 0);
	mode = "running";
	await page.clock.runFor(15000);
	await ready();
	assert.equal(await page.locator("#qc-running").textContent(), "1");
	await page.locator("#collapsebtn").click();
	const hiddenCalls = calls;
	await page.clock.runFor(30000);
	assert.equal(calls, hiddenCalls, "no polling while collapsed");
	mode = "stopped";
	await page.locator('[data-crview="rview-twins"]').click();
	await ready();
	assert.equal(await page.locator("#qc-running").textContent(), "0");
	mode = "held";
	await page.locator("#twinsrefresh").click();
	await page.waitForFunction(
		() =>
			document.querySelector<HTMLButtonElement>("#twinsrefresh")?.disabled ===
			true,
	);
	const heldCalls = calls;
	await page.clock.runFor(30000);
	assert.equal(calls, heldCalls, "no overlapping reads");
	mode = "running";
	assert.ok(release);
	release();
	await ready();
	mode = "failed";
	await page.locator("#twinsrefresh").click();
	await ready();
	assert.equal(await page.locator("#qc-running").textContent(), "—");
	assert.equal(await page.locator("#twinbadge").isVisible(), false);
	mode = "unavailable";
	await page.locator("#twinsrefresh").click();
	await ready();
	assert.match(
		(await page.locator("#twinlist").textContent()) ?? "",
		/quickchr unavailable/,
	);
	mode = "running";
	await page.locator("#twinsrefresh").click();
	await ready();
	assert.equal(await page.locator("#qc-running").textContent(), "1");
	for (const theme of ["dark", "light"]) {
		await page.evaluate((t) => {
			document.documentElement.setAttribute("data-theme", t);
		}, theme);
		await page.screenshot({ path: `${out}/t167-twins-${theme}.png` });
	}
	await page.evaluate(() =>
		document.getElementById("lockscreen")?.classList.add("open"),
	);
	const lockedCalls = calls;
	await page.clock.runFor(30000);
	assert.equal(calls, lockedCalls, "no polling while locked");
	await page.evaluate(() =>
		document.getElementById("lockscreen")?.classList.remove("open"),
	);
	await ready();
	assert.ok(calls > lockedCalls, "unlocking reloads the visible panel");
	await page.locator('[data-rview="rview-settings"]').click();
	const tabCalls = calls;
	await page.clock.runFor(30000);
	assert.equal(calls, tabCalls, "no polling on another tab");
	await page.locator('[data-rview="rview-twins"]').click();
	await ready();
	assert.ok(calls > tabCalls, "reopening reloads");
	assert.deepEqual(pageErrors, [], "no browser script errors");
	assert.deepEqual(consoleErrors, [], "no unexpected console errors");
	console.log(
		"PASS T167 twins: refresh, polling, collapse, reopen, single-flight, failure, recovery, themes",
	);
}
