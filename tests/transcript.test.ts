// T37 transcript mapper tests: pure, hermetic, no muse needed.
import { describe, expect, test } from "bun:test";
import type { ViewEvent } from "../src/msp/client";
import { transcriptItems } from "../src/serve/server";

function ev(method: string, item: Record<string, unknown>): ViewEvent {
	return { method, params: { item } };
}

const done = (item: Record<string, unknown>) => ev("item/completed", item);

describe("transcriptItems", () => {
	test("messages keep chronological order; textless rows drop", () => {
		const items = transcriptItems([
			done({
				itemId: "u1",
				kind: "userMessage",
				status: "completed",
				text: "hello",
			}),
			done({
				itemId: "a1",
				kind: "agentMessage",
				status: "completed",
				text: "",
			}),
			done({
				itemId: "a2",
				kind: "agentMessage",
				status: "completed",
				text: "hi back",
			}),
		]);
		expect(items).toEqual([
			{ kind: "userMessage", role: "user", text: "hello" },
			{ kind: "agentMessage", role: "agent", text: "hi back" },
		]);
	});

	test("latest revision wins across completed/updated", () => {
		const items = transcriptItems([
			done({
				itemId: "a1",
				kind: "agentMessage",
				status: "inProgress",
				text: "partial",
			}),
			ev("item/updated", {
				itemId: "a1",
				kind: "agentMessage",
				status: "completed",
				text: "full",
			}),
		]);
		expect(items).toEqual([
			{ kind: "agentMessage", role: "agent", text: "full" },
		]);
	});

	test("non-item events are ignored", () => {
		const items = transcriptItems([
			{ method: "turn/completed", params: { turnId: "t1" } },
			{ method: "session/tokenUsage", params: { totalTokens: 9 } },
			done({
				itemId: "u1",
				kind: "userMessage",
				status: "completed",
				text: "x",
			}),
		]);
		expect(items.length).toBe(1);
	});

	test("bash toolCall maps command hint plus visible output", () => {
		const [row] = transcriptItems([
			done({
				itemId: "c1",
				kind: "toolCall",
				tool: "bash",
				status: "completed",
				args: JSON.stringify({
					command: "centrs discover",
					description: "scan",
				}),
				visibleOutput: "found 1\n",
			}),
		]);
		expect(row).toMatchObject({
			kind: "toolCall",
			tool: "bash",
			status: "completed",
			hint: "centrs discover",
			output: "found 1\n",
			itemId: "c1",
		});
	});

	test("write toolCall maps path hint, patch summary, and available refs", () => {
		const [row] = transcriptItems([
			done({
				itemId: "c2",
				kind: "toolCall",
				tool: "write_file",
				status: "completed",
				args: JSON.stringify({ path: "router.toml", content: "x" }),
				patchSummary: { added: 3, removed: 1, files: 1 },
				patchRef: {
					availability: "available",
					id: "tool_patch-1",
					kind: "tool_patch",
				},
				outputRef: { availability: "missing", id: "bash-1", kind: "bash" },
			}),
		]);
		if (!row) throw new Error("expected one transcript row");
		expect(row).toMatchObject({
			kind: "toolCall",
			tool: "write_file",
			hint: "router.toml",
			patch: { added: 3, removed: 1, files: 1 },
			patchRef: "tool_patch-1",
		});
		expect(row.outputRef).toBeUndefined();
	});

	test("unparseable args fall back to the bare tool name", () => {
		const [row] = transcriptItems([
			done({
				itemId: "c3",
				kind: "toolCall",
				tool: "bash",
				status: "completed",
				args: "{oops",
			}),
		]);
		if (!row) throw new Error("expected one transcript row");
		expect(row.hint).toBe("bash");
	});

	test("failed toolCall carries the failure reason", () => {
		const [row] = transcriptItems([
			done({
				itemId: "c4",
				kind: "toolCall",
				tool: "bash",
				status: "failed",
				args: JSON.stringify({ command: "exit 3" }),
				failureReason: "process exited with status 1",
				visibleOutput: "boom\n",
			}),
		]);
		expect(row).toMatchObject({
			status: "failed",
			failureReason: "process exited with status 1",
		});
	});

	test("subagent maps objective, role, child, and result summary", () => {
		const [row] = transcriptItems([
			done({
				itemId: "s1",
				kind: "subagent",
				status: "completed",
				objective: "Survey the docs",
				role: "research",
				childSessionId: "child-1",
				controlStatus: "completed",
				result: { summary: "three pages read" },
			}),
		]);
		expect(row).toMatchObject({
			kind: "subagent",
			status: "completed",
			objective: "Survey the docs",
			hint: "research",
			childSessionId: "child-1",
			resultSummary: "three pages read",
			controlStatus: "completed",
		});
	});

	test("reasoning and unknown kinds fall back to raw text", () => {
		const items = transcriptItems([
			done({
				itemId: "r1",
				kind: "reasoning",
				status: "completed",
				summary: ["step one", "step two"],
			}),
			done({
				itemId: "w1",
				kind: "workflow",
				status: "inProgress",
				fallbackText: "Workflow: demo run",
			}),
			done({ itemId: "z1", kind: "futureKind", status: "completed" }),
		]);
		expect(items[0]).toMatchObject({
			kind: "reasoning",
			text: "step one\nstep two",
		});
		expect(items[1]).toMatchObject({
			kind: "workflow",
			text: "Workflow: demo run",
		});
		expect(items[2]).toMatchObject({
			kind: "futureKind",
			status: "completed",
			text: "",
		});
	});
});
