// Render-key provisioning tests (T83 followup 2): the provenance key
// is fail-closed — symlinks and non-regular files are never used or
// written through, wide modes are repaired to 0600, wrong-length keys
// are kept (never overwritten), and concurrent first signers agree on
// one key via an atomic link. Hermetic: temp homes, cleaned after.
// Never the real data home.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import * as nodeCrypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import {
	ensureRenderKey,
	readRenderKey,
	renderKeyFile,
} from "../src/lib/renderSig";
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

function writeKeyFile(dh: string, bytes: Buffer, mode: number): string {
	const file = renderKeyFile(dh);
	nodeFs.mkdirSync(path.dirname(file), { recursive: true });
	nodeFs.writeFileSync(file, bytes);
	nodeFs.chmodSync(file, mode);
	return file;
}

describe("render key provisioning", () => {
	test("an existing 0644 key is chmodded to 0600 before use", () => {
		const dh = makeDir("t83-key-dh-");
		const want = nodeCrypto.randomBytes(32);
		const file = writeKeyFile(dh, want, 0o644);
		expect(nodeFs.statSync(file).mode & 0o777).toBe(0o644);
		expect(ensureRenderKey(dh)).toEqual(want);
		expect(nodeFs.statSync(file).mode & 0o777).toBe(0o600);
		// The verify path repairs too.
		nodeFs.chmodSync(file, 0o644);
		expect(readRenderKey(dh)).toEqual(want);
		expect(nodeFs.statSync(file).mode & 0o777).toBe(0o600);
	});

	test("a symlink key is never written through", () => {
		const dh = makeDir("t83-key-dh-");
		const file = renderKeyFile(dh);
		nodeFs.mkdirSync(path.dirname(file), { recursive: true });
		const target = path.join(dh, "target.bin");
		nodeFs.writeFileSync(target, "short");
		nodeFs.symlinkSync(target, file);
		expect(() => ensureRenderKey(dh)).toThrow(/symlink/);
		expect(nodeFs.readFileSync(target, "utf8")).toBe("short");
		expect(nodeFs.lstatSync(file).isSymbolicLink()).toBe(true);
		expect(readRenderKey(dh)).toBeNull();
	});

	test("a non-regular key path fails closed", () => {
		const dh = makeDir("t83-key-dh-");
		const file = renderKeyFile(dh);
		nodeFs.mkdirSync(path.dirname(file), { recursive: true });
		nodeFs.mkdirSync(file);
		expect(() => ensureRenderKey(dh)).toThrow(/not a regular file/);
		expect(readRenderKey(dh)).toBeNull();
	});

	test("a wrong-length key is kept, never overwritten", () => {
		const dh = makeDir("t83-key-dh-");
		const file = writeKeyFile(dh, Buffer.from("sixteen-bytes-xx"), 0o600);
		expect(nodeFs.statSync(file).size).toBe(16);
		expect(() => ensureRenderKey(dh)).toThrow(/wrong length/);
		expect(nodeFs.readFileSync(file, "utf8")).toBe("sixteen-bytes-xx");
		expect(readRenderKey(dh)).toBeNull();
	});

	test("two concurrent first signs agree on one key", async () => {
		const dh = makeDir("t83-key-race-dh-");
		const mod = path.join(import.meta.dir, "..", "src", "lib", "renderSig.ts");
		const code = `const m = await import(${JSON.stringify(mod)}); console.log(m.ensureRenderKey(${JSON.stringify(dh)}).toString("hex"));`;
		// One shell, both signers backgrounded: start times as close as
		// the OS allows, so a check-then-write race actually collides.
		const sh = Bun.spawn(
			[
				"bash",
				"-c",
				`bun -e ${JSON.stringify(code)} > ${dh}.a 2>${dh}.ae & bun -e ${JSON.stringify(code)} > ${dh}.b 2>${dh}.be & wait`,
			],
			{ stdout: "ignore", stderr: "ignore" },
		);
		expect(await sh.exited).toBe(0);
		const oa = nodeFs.readFileSync(`${dh}.a`, "utf8").trim();
		const ob = nodeFs.readFileSync(`${dh}.b`, "utf8").trim();
		expect(oa).toMatch(/^[0-9a-f]{64}$/);
		expect(ob).toBe(oa);
		expect(nodeFs.readFileSync(renderKeyFile(dh)).toString("hex")).toBe(oa);
		expect(nodeFs.statSync(renderKeyFile(dh)).mode & 0o777).toBe(0o600);
		nodeFs.rmSync(`${dh}.a`, { force: true });
		nodeFs.rmSync(`${dh}.b`, { force: true });
		nodeFs.rmSync(`${dh}.ae`, { force: true });
		nodeFs.rmSync(`${dh}.be`, { force: true });
	});
});

describe("render key write failure (T83 re-review 3)", () => {
	test("a failed key write closes its descriptor and leaves no tmp", () => {
		const dh = makeDir("t83-fu3-keyfail-");
		const opened: number[] = [];
		const closed: number[] = [];
		const origOpen = nodeFs.openSync;
		const origClose = nodeFs.closeSync;
		const openSpy = spyOn(nodeFs, "openSync").mockImplementation(((
			...args: Parameters<typeof nodeFs.openSync>
		) => {
			const fd = (origOpen as (...a: unknown[]) => number)(...args);
			opened.push(fd);
			return fd;
		}) as typeof nodeFs.openSync);
		const writeSpy = spyOn(nodeFs, "writeSync").mockImplementation((() => {
			const e = new Error("ENOSPC: no space left") as NodeJS.ErrnoException;
			e.code = "ENOSPC";
			throw e;
		}) as typeof nodeFs.writeSync);
		const closeSpy = spyOn(nodeFs, "closeSync").mockImplementation(((
			fd: number,
		) => {
			closed.push(fd);
			(origClose as (fd: number) => void)(fd);
		}) as typeof nodeFs.closeSync);
		try {
			expect(() => ensureRenderKey(dh)).toThrow(/ENOSPC/);
		} finally {
			openSpy.mockRestore();
			writeSpy.mockRestore();
			closeSpy.mockRestore();
		}
		expect(opened.length).toBeGreaterThan(0);
		for (const fd of opened) expect(closed).toContain(fd);
		const left = nodeFs.existsSync(path.dirname(renderKeyFile(dh)))
			? nodeFs.readdirSync(path.dirname(renderKeyFile(dh)))
			: [];
		expect(left).toEqual([]);
	});
});
