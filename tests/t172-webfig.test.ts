import { expect, test } from "bun:test";
import { deviceWebfigUrl } from "../src/lib/fleet";

test("WebFig URL accepts hostnames and IPv6, rejects credentials and malformed ports", () => {
	expect(deviceWebfigUrl("demo-router", "7080")).toBe(
		"http://demo-router:7080/webfig/",
	);
	expect(deviceWebfigUrl("2001:db8::1")).toBe("http://[2001:db8::1]/webfig/");
	for (const name of [
		"user:secret@router",
		"router/path",
		"router?x",
		"router#x",
		"router\\path",
		"router name",
	])
		expect(deviceWebfigUrl(name)).toBeUndefined();
	for (const port of ["0", "65536", "bad", ""])
		expect(deviceWebfigUrl("router", port)).toBeUndefined();
});
