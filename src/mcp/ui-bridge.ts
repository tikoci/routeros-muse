#!/usr/bin/env bun
// T55 (D41): stdio MCP bridge for the routeros-muse ui_* tools.
//
// muse spawns one of these per session (sessionMcp +
// config.mcpServers at session/start) and speaks newline-delimited
// JSON-RPC on stdio (the B2-grounded framing). The bridge answers
// initialize and tools/list locally and relays tools/call to the
// running server over loopback HTTP, authenticated by the
// per-session token. It inherits the worker env (including the
// private XDG_CONFIG_HOME); the relay coordinates arrive via the
// mcpServers env below.
//
// Self-contained by design: no imports, no package code — only
// bun globals (fetch, process, TextDecoder). The tool set is
// pinned against src/mcp/ui-tools.ts by tests/t55-ui-mcp.test.ts.

const RELAY_URL_ENV = "ROUTEROS_MUSE_URL";
const RELAY_TOKEN_ENV = "ROUTEROS_MUSE_MCP_TOKEN";

type ToolDef = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
};

const TOOLS: ToolDef[] = [
	{
		name: "ui_notify",
		description:
			"Show a short toast in the routeros-muse UI. USE THIS when the user asks to display a message, or to flag something needing attention.",
		inputSchema: {
			type: "object",
			properties: {
				text: { type: "string", description: "Toast text, one or two lines." },
				level: {
					type: "string",
					enum: ["info", "warn", "alert"],
					description: "Severity tint. Defaults to info.",
				},
			},
			required: ["text"],
			additionalProperties: false,
		},
	},
	{
		name: "ui_open",
		description:
			"Open a workspace file in a center tab of the routeros-muse UI (docs, TOML, and renderable artifacts each open in their own viewer). USE THIS to show the user a file.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"Workspace-relative path, e.g. notes/plan.md. Must stay inside the workspace.",
				},
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
	{
		name: "ui_select_device",
		description:
			"Set the target chip in the routeros-muse UI to a device id (a CDB target, as in the device list or devices.toml), so follow-up chat is about that device.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description:
						"Device id: the CDB target (see devices.toml or centrs devices list).",
				},
			},
			required: ["id"],
			additionalProperties: false,
		},
	},
	{
		name: "ui_add_device",
		description:
			"Open the Add device dialog in the routeros-muse UI prefilled with host and user, so the owner types the password in the UI. USE THIS when the owner is asked to add a device: NEVER ask for or accept a password in chat. The dialog opens only; the owner may cancel, and saving is their click.",
		inputSchema: {
			type: "object",
			properties: {
				host: {
					type: "string",
					description:
						"Device address: IPv4, IPv6, or hostname. Displayed only, never edited into config by the tool.",
				},
				user: {
					type: "string",
					description: "Login user, prefilled in the dialog.",
				},
				id: {
					type: "string",
					description:
						"Optional device id slug (lowercase letters, digits, dashes). Derived from the host when omitted.",
				},
			},
			required: ["host"],
			additionalProperties: false,
		},
	},
];

/** Relay round-trip cap per tool call. */
const RELAY_TIMEOUT_MS = 30_000;

function textResult(text: string, isError?: boolean): Record<string, unknown> {
	return {
		content: [{ type: "text", text }],
		...(isError === true ? { isError: true } : {}),
	};
}

type RelayOut =
	| { kind: "result"; result: Record<string, unknown> }
	| { kind: "error"; message: string };

async function relay(
	url: string,
	token: string,
	tool: string,
	args: unknown,
): Promise<RelayOut> {
	let res: Response;
	try {
		res = await fetch(`${url.replace(/\/+$/, "")}/api/mcp/relay`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token, tool, arguments: args ?? {} }),
			// A wedged server must not hang the agent's tool call.
			signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
		});
	} catch (err) {
		return {
			kind: "error",
			message: `relay unreachable: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	let body: Record<string, unknown>;
	try {
		body = (await res.json()) as Record<string, unknown>;
	} catch {
		return { kind: "error", message: `relay returned status ${res.status}` };
	}
	// A relay refusal (401 token, 400 malformed) is a JSON-RPC
	// error: the call never reached a tool. A 200 ok:false is the
	// tool's own refusal and rides isError.
	if (!res.ok) {
		return {
			kind: "error",
			message: `relay ${res.status}: ${typeof body["why"] === "string" ? body["why"] : "request failed"}`,
		};
	}
	if (body["ok"] === true) {
		return {
			kind: "result",
			result: textResult(
				typeof body["result"] === "string" ? body["result"] : "ok",
			),
		};
	}
	return {
		kind: "result",
		result: textResult(
			typeof body["why"] === "string" ? body["why"] : "tool failed",
			true,
		),
	};
}

async function main(): Promise<void> {
	const reader = Bun.stdin.stream().getReader();
	const decoder = new TextDecoder();
	let buf = "";
	function write(obj: unknown): void {
		process.stdout.write(`${JSON.stringify(obj)}\n`);
	}
	async function handle(msg: Record<string, unknown>): Promise<void> {
		const id = msg["id"] as number | string | undefined;
		const method = msg["method"];
		if (method === "initialize") {
			const params = (msg["params"] as Record<string, unknown>) ?? {};
			write({
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion:
						typeof params["protocolVersion"] === "string"
							? params["protocolVersion"]
							: "2024-11-05",
					capabilities: { tools: {} },
					serverInfo: { name: "routeros_muse", version: "0.1" },
				},
			});
			return;
		}
		if (typeof method === "string" && method.startsWith("notifications/"))
			return;
		if (method === "tools/list") {
			write({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
			return;
		}
		if (method === "tools/call") {
			const params = (msg["params"] as Record<string, unknown>) ?? {};
			const url = process.env[RELAY_URL_ENV] ?? "";
			const token = process.env[RELAY_TOKEN_ENV] ?? "";
			if (!url || !token) {
				const missing = [
					...(!url ? [RELAY_URL_ENV] : []),
					...(!token ? [RELAY_TOKEN_ENV] : []),
				].join(" and ");
				write({
					jsonrpc: "2.0",
					id,
					error: {
						code: -32000,
						message: `routeros-muse relay not configured (missing ${missing})`,
					},
				});
				return;
			}
			const out = await relay(
				url,
				token,
				typeof params["name"] === "string" ? params["name"] : "",
				(params["arguments"] as Record<string, unknown> | undefined) ?? {},
			);
			if (out.kind === "result") {
				write({ jsonrpc: "2.0", id, result: out.result });
			} else {
				write({
					jsonrpc: "2.0",
					id,
					error: { code: -32000, message: out.message },
				});
			}
			return;
		}
		if (id !== undefined) {
			write({
				jsonrpc: "2.0",
				id,
				error: { code: -32601, message: `unknown method ${String(method)}` },
			});
		}
	}
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (line) {
					try {
						await handle(JSON.parse(line) as Record<string, unknown>);
					} catch {
						// Malformed input is never a response; keep reading.
					}
				}
				nl = buf.indexOf("\n");
			}
		}
	} catch {
		// stdin closed under us; exit cleanly below
	} finally {
		reader.releaseLock();
	}
}

await main();
