// MSP client anchor tests (T31 slice 1, D22). Hermetic: echo provider
// plus an isolated XDG_DATA_HOME, so no API cost and no litter in the
// real muse home. Skipped when `muse` is not on PATH.
import { afterAll, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { have } from "../src/lib/run";
import { toolEnv } from "../src/lib/tools";
import { uiMcpServers } from "../src/mcp/ui-tools";
import { MspClient, MspError } from "../src/msp/client";
import { cleanupTmpdirs, mktmp } from "./helpers/tmp";

afterAll(cleanupTmpdirs);

const HAVE_MUSE = have("muse");
const t = HAVE_MUSE ? test : test.skip;

// 1x1 red PNG.
const PNG1 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const CATALOG_FIXTURE = path.join(import.meta.dir, "fixtures", "model-catalog");

// T55: every spawn carries the ui MCP config. The relay URL is a
// dummy (echo turns never call tools, so the bridge is never
// dialed); the bridge path is real, so a broken bridge breaks the
// session start loudly instead of shipping a dead tool.
function testMcp(): ReturnType<typeof uiMcpServers> {
	return uiMcpServers({
		bridge: path.join(
			path.resolve(import.meta.dir, ".."),
			"src",
			"mcp",
			"ui-bridge.ts",
		),
		bun: process.execPath,
		url: "http://127.0.0.1:9/",
		token: "t31-dummy-token",
	});
}

// A fresh muse home ships no model catalog, which also withholds live
// contextUsage (no pressure basis). Seed the cache so echo tests see
// what a logged-in home sees.
function seedCatalog(home: string): void {
	const dir = path.join(home, "muse", "model-catalog");
	nodeFs.mkdirSync(dir, { recursive: true });
	for (const f of nodeFs.readdirSync(CATALOG_FIXTURE)) {
		nodeFs.copyFileSync(path.join(CATALOG_FIXTURE, f), path.join(dir, f));
	}
}

function makeHome(seeded = true): { home: string; ws: string } {
	const home = mktmp("t31-msp-home-");
	const ws = mktmp("t31-msp-ws-");
	nodeFs.writeFileSync(path.join(ws, "workspace.toml"), "canonical = true\n");
	if (seeded) seedCatalog(home);
	return { home, ws };
}

describe("msp echo hello-world", () => {
	t(
		"turn completes and echoes the prompt",
		async () => {
			const { home, ws } = makeHome();
			const c = await MspClient.spawn({
				provider: "echo",
				museHome: home,
				mcpServers: testMcp(),
			});
			try {
				const { session } = await c.sessionStart({
					workspaceRoot: ws,
					approvalMode: "allowAll",
				});
				expect(session.sessionId).toBeString();
				const out = await c.runTurn({
					sessionId: session.sessionId,
					input: [{ type: "text", text: "HELLO-SPIKE-OK" }],
				});
				expect(out.terminal).toBe("completed");
				expect(out.agentTexts.join("\n")).toContain("HELLO-SPIKE-OK");
			} finally {
				await c.close();
			}
		},
		60_000,
	);

	t(
		"image part is admitted and echoed as an attachment",
		async () => {
			const { home, ws } = makeHome();
			const c = await MspClient.spawn({
				provider: "echo",
				museHome: home,
				mcpServers: testMcp(),
			});
			try {
				const { session } = await c.sessionStart({
					workspaceRoot: ws,
					approvalMode: "allowAll",
				});
				const out = await c.runTurn({
					sessionId: session.sessionId,
					input: [
						{ type: "text", text: "describe this" },
						{ type: "image", base64Data: PNG1, mediaType: "image/png" },
					],
				});
				expect(out.terminal).toBe("completed");
				expect(out.agentTexts.join("\n")).toContain("[Image #1]");
			} finally {
				await c.close();
			}
		},
		60_000,
	);

	t(
		"malformed image is rejected invalidParams",
		async () => {
			const { home, ws } = makeHome();
			const c = await MspClient.spawn({
				provider: "echo",
				museHome: home,
				mcpServers: testMcp(),
			});
			try {
				const { session } = await c.sessionStart({
					workspaceRoot: ws,
					approvalMode: "allowAll",
				});
				const err = await c
					.turnStart({
						sessionId: session.sessionId,
						input: [
							{
								type: "image",
								base64Data: "!!!not-base64!!!",
								mediaType: "image/png",
							},
						],
					})
					.then(
						() => null,
						(e: unknown) => e,
					);
				expect(err).toBeInstanceOf(MspError);
				expect((err as MspError).kind).toBe("invalidParams");
			} finally {
				await c.close();
			}
		},
		60_000,
	);

	t(
		"steer after done is refused; interrupt when idle is missing_run",
		async () => {
			const { home, ws } = makeHome();
			const c = await MspClient.spawn({
				provider: "echo",
				museHome: home,
				mcpServers: testMcp(),
			});
			try {
				const { session } = await c.sessionStart({
					workspaceRoot: ws,
					approvalMode: "allowAll",
				});
				const out = await c.runTurn({
					sessionId: session.sessionId,
					input: [{ type: "text", text: "quick" }],
				});
				const steerErr = await c
					.turnSteer({
						sessionId: session.sessionId,
						expectedTurnId: out.turnId,
						input: [{ type: "text", text: "too late" }],
					})
					.then(
						() => null,
						(e: unknown) => e,
					);
				expect(steerErr).toBeInstanceOf(MspError);
				expect((steerErr as MspError).reason).toBe("already_terminal");
				const intErr = await c
					.turnInterrupt({ sessionId: session.sessionId })
					.then(
						() => null,
						(e: unknown) => e,
					);
				expect(intErr).toBeInstanceOf(MspError);
				expect((intErr as MspError).reason).toBe("missing_run");
			} finally {
				await c.close();
			}
		},
		60_000,
	);

	t(
		"model catalog lists named models with defaults",
		async () => {
			const { home, ws } = makeHome();
			const c = await MspClient.spawn({
				provider: "echo",
				museHome: home,
				mcpServers: testMcp(),
			});
			try {
				await c.sessionStart({ workspaceRoot: ws, approvalMode: "allowAll" });
				const catalog = await c.modelList();
				expect(catalog.models.length).toBeGreaterThan(0);
				for (const m of catalog.models) {
					expect(typeof m.modelId).toBe("string");
				}
				expect(catalog.models.some((m) => m.isDefault)).toBe(true);
			} finally {
				await c.close();
			}
		},
		60_000,
	);

	t(
		"effort and access setters are accepted; model forwards host answer",
		async () => {
			const { home, ws } = makeHome();
			const c = await MspClient.spawn({
				provider: "echo",
				museHome: home,
				mcpServers: testMcp(),
			});
			try {
				const { session } = await c.sessionStart({
					workspaceRoot: ws,
					approvalMode: "allowAll",
				});
				await c.sessionSetReasoningEffort(session.sessionId, "max");
				await c.sessionSetApprovalMode(session.sessionId, "onRequest");
				// Echo cannot serve catalog models: the host rejection must surface typed.
				const err = await c
					.sessionSetModel(session.sessionId, "muse-spark-1.3")
					.then(
						() => null,
						(e: unknown) => e,
					);
				expect(err).toBeInstanceOf(MspError);
				expect((err as MspError).kind).toBe("commandRejected");
			} finally {
				await c.close();
			}
		},
		60_000,
	);

	t(
		"past-chat store: list, page, read, rename",
		async () => {
			const { home, ws } = makeHome();
			const c = await MspClient.spawn({
				provider: "echo",
				museHome: home,
				mcpServers: testMcp(),
			});
			try {
				const { session } = await c.sessionStart({
					workspaceRoot: ws,
					approvalMode: "allowAll",
				});
				await c.runTurn({
					sessionId: session.sessionId,
					input: [{ type: "text", text: "remember me" }],
				});
				const list = await c.sessionList();
				expect(list.sessions.map((s) => s.sessionId)).toContain(
					session.sessionId,
				);
				const page = await c.viewPage({
					sessionId: session.sessionId,
					limit: 20,
					direction: "backward",
				});
				expect(page.events.length).toBeGreaterThan(0);
				expect(page.events.map((e) => e.method)).toContain("turn/completed");
				const read = await c.sessionRead(session.sessionId);
				expect(read["session"]).toBeDefined();
				const renamed = await c.sessionRename(session.sessionId, "spike-past");
				expect(renamed["name"]).toBe("spike-past");
			} finally {
				await c.close();
			}
		},
		90_000,
	);
});

describe("spawn environment", () => {
	// POSIX-only: the stub host is a shell script. No muse needed —
	// the stub answers initialize itself and records its PATH.
	const tstub = process.platform === "win32" ? test.skip : test;

	tstub(
		"spawn resolves muse and PATH from the passed env",
		async () => {
			const dir = mktmp("t51-musen-");
			const outFile = path.join(dir, "seen-path.txt");
			nodeFs.writeFileSync(
				path.join(dir, "muse"),
				'#!/bin/sh\necho "$PATH" > "$STUB_OUT"\nIFS= read -r req\nprintf \'{"jsonrpc":"2.0","id":1,"result":{}}\\n\'\ncat > /dev/null\n',
			);
			nodeFs.chmodSync(path.join(dir, "muse"), 0o755);
			const env = toolEnv(dir, {
				...process.env,
				STUB_OUT: outFile,
			} as NodeJS.ProcessEnv);
			const c = await MspClient.spawn({
				provider: "echo",
				env,
				mcpServers: testMcp(),
			});
			try {
				const seen = nodeFs.readFileSync(outFile, "utf8").trim();
				expect(seen.split(path.delimiter)[0]).toBe(dir);
			} finally {
				await c.close();
			}
		},
		30_000,
	);
});

describe("runTurn coalesced completion (T49 re-review)", () => {
	// A stub `muse serve` that answers turn/start and emits that turn's
	// turn/completed in ONE write: a listener installed only after the
	// turn/start await would miss it and time out.
	test("completion delivered with the turn/start response is not lost", async () => {
		const dir = mktmp("t49-coalesce-");
		const stub = path.join(dir, "muse");
		nodeFs.writeFileSync(
			stub,
			`#!/usr/bin/env bun
const dec = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
	buf += dec.decode(chunk);
	let i;
	while ((i = buf.indexOf("\\n")) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		const m = JSON.parse(line);
		if (m.id === undefined) continue;
		if (m.method === "turn/start") {
			const resp = { jsonrpc: "2.0", id: m.id, result: { turnId: "tc-1" } };
			const done = { jsonrpc: "2.0", method: "turn/completed",
				params: { sessionId: m.params.sessionId, turnId: "tc-1", terminal: "completed" } };
			process.stdout.write(JSON.stringify(resp) + "\\n" + JSON.stringify(done) + "\\n");
		} else {
			process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\\n");
		}
	}
}
`,
		);
		nodeFs.chmodSync(stub, 0o755);
		const env = toolEnv(dir);
		const c = await MspClient.spawn({
			provider: "echo",
			env,
			mcpServers: testMcp(),
			timeoutMs: 5_000,
		});
		try {
			const out = await c.runTurn({
				sessionId: "s-1",
				input: [{ type: "text", text: "hi" }],
				timeoutMs: 2_000,
			});
			expect(out.turnId).toBe("tc-1");
			expect(out.terminal).toBe("completed");
		} finally {
			await c.close();
		}
	});
});

describe("sessionMcp negotiation (T55)", () => {
	// A stub `muse serve` that records initialize + session/start
	// params: proves the client negotiates sessionMcp and carries
	// the servers on every session start, structurally.
	for (const deny of [false, true])
		test(
			deny
				? "a host withholding sessionMcp gets no config, so chat keeps working"
				: "initialize requests sessionMcp; session/start carries mcpServers",
			async () => {
				const dir = mktmp("t55-caps-");
				const seen = path.join(dir, "seen.jsonl");
				const stub = path.join(dir, "muse");
				// Sync append per line: truncated writers would keep only the tail.
				nodeFs.writeFileSync(
					stub,
					`#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const dec = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
	buf += dec.decode(chunk);
	let i;
	while ((i = buf.indexOf("\\n")) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		const m = JSON.parse(line);
		if (m.id === undefined) continue;
		appendFileSync(process.env["STUB_OUT"], line + "\\n");
		if (m.method === "session/start") {
			process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { session: { sessionId: "s-1" }, viewCursor: "" } }) + "\\n");
		} else if (m.method === "initialize") {
			const grant = process.env["STUB_DENY_SESSION_MCP"] === "1" ? [] : ["sessionMcp"];
			process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { grantedCapabilities: grant } }) + "\\n");
		} else {
			process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\\n");
		}
	}
}
`,
				);
				nodeFs.chmodSync(stub, 0o755);
				const env = toolEnv(dir, {
					...process.env,
					STUB_OUT: seen,
					STUB_DENY_SESSION_MCP: deny ? "1" : "0",
				} as NodeJS.ProcessEnv);
				const c = await MspClient.spawn({
					provider: "echo",
					env,
					mcpServers: testMcp(),
					timeoutMs: 5_000,
				});
				try {
					await c.sessionStart({ workspaceRoot: mktmp("t55-caps-ws-") });
					const lines = nodeFs
						.readFileSync(seen, "utf8")
						.split("\n")
						.filter((l) => l.trim())
						.map((l) => JSON.parse(l) as Record<string, unknown>);
					const init = lines.find(
						(m) => m["method"] === "initialize",
					) as Record<string, unknown>;
					expect(
						(
							(init["params"] as Record<string, unknown>)[
								"capabilities"
							] as Record<string, unknown>
						)["requestedCapabilities"],
					).toEqual(["sessionMcp"]);
					const start = lines.find(
						(m) => m["method"] === "session/start",
					) as Record<string, unknown>;
					const config = (start["params"] as Record<string, unknown>)[
						"config"
					] as Record<string, unknown> | undefined;
					if (deny) {
						expect(config).toBeUndefined();
						expect(c.uiTools).toBe(false);
					} else {
						expect(config?.["mcpServers"]).toEqual(testMcp());
						expect(c.uiTools).toBe(true);
					}
				} finally {
					await c.close();
				}
			},
		);
});
