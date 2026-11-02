// T50 scriptable fake `muse serve` (stdin/stdout JSONL) plus the hermetic
// harness around it. Shared by the suite (tests/t50-approval.test.ts)
// and the browser smoke (tools/ui-smoke.ts): one fake source, no drift.
//
// The fake emits the captured wire shapes from
// out/wire-capture/20261101T210403Z (docs/design/t50-t55-wire-shapes.md):
// approval/request + approval/requested twins keyed by approvalId,
// approval/decide with the requirementId race guard, approval/updated +
// approval/resolved, userInput/request + userInput/requested,
// userInput/answer + userInput/settled, approval/listPending, and the
// interrupt path (approval→abort/deny, question→aborted/run_aborted,
// turn→cancelled, all with decidedByCommandId null).
//
// Prompt-driven scenarios (substring match on the turn's text input):
// - NEED-APPROVAL: one shell approval (capture-08 shapes, 3 choices)
// - NEED-QUESTION: one single-select question (capture-12 Tabs/Spaces)
// - NEED-MULTI: two questions, one single + one multiple-select
// - NEED-BOTH: one approval plus one question
// Anything else completes immediately with an agentMessage echo.
import * as nodeFs from "node:fs";
import * as path from "node:path";
import type { ApprovalMode } from "../src/msp/client";
import { startServer } from "../src/serve/server";
import { mktmp } from "./helpers/tmp";

// Plain JS in a .ts file: generated into the temp bin dir at runtime,
// never linted. Runs under the bun binary (process.execPath).
export const T50_FAKE_MUSE = String.raw`
// T50 scriptable fake muse host: JSONL over stdio.
import * as fs from "node:fs";
import * as readline from "node:readline";

const log = process.env["T50_LOG"] ?? "";
function logLine(line) {
	if (log) fs.appendFileSync(log, line + "\n");
}

const SESSION = "t50-s1";
let workspaceRoot = "";
// T101: the live profile id (canned permissionState per profile,
// captured shapes: :ask-me sandboxed/off/human, :unrestricted open).
let liveProfile = ":unrestricted";
function permState(id) {
	const sandboxed = id === ":ask-me" || id === ":auto-review" || id === ":read-only";
	return {
		axes: sandboxed
			? { approval: "onRequest", filesystem: "sandboxed", network: "off", reviewer: "human" }
			: { approval: "allowAll", filesystem: "unrestricted", network: "enabled", reviewer: "none" },
		profileId: id,
		reviewerAttached: true,
		reviewerAuthority: sandboxed ? "human" : "none",
	};
}
const turns = [];
let turnN = 0;
let apprN = 0;
let qN = 0;
let reqN = 0;
let cursorN = 0;
let liveTurn = null;
const approvals = new Map();
const questions = new Map();
logLine("SPAWN pid=" + process.pid);

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let dead = false;
function onEof() {
	if (dead) return;
	dead = true;
	logLine("EOF");
	process.exit(0);
}
rl.on("close", onEof);
process.stdin.on("end", onEof);
process.stdin.resume();

function send(obj) {
	if (dead) return;
	process.stdout.write(JSON.stringify(obj) + "\n");
}
function notify(method, params) {
	send({ jsonrpc: "2.0", method: method, params: params });
}
function serverRequest(method, params) {
	reqN += 1;
	send({ jsonrpc: "2.0", id: reqN, method: method, params: params });
}
function cursor() {
	cursorN += 1;
	return "v4:" + SESSION + ":" + cursorN;
}
function srcRange() {
	const id = "t50-e" + cursorN;
	return {
		first: { id: id, sequence: cursorN },
		last: { id: id, sequence: cursorN },
		stream: { id: SESSION, kind: "session" },
	};
}
function errTo(id, code, message, kind, extra) {
	send({
		jsonrpc: "2.0",
		id: id,
		error: Object.assign(
			{ code: code, message: message, data: { kind: kind, retryable: false } },
			extra ?? {},
		),
	});
}

function makeApproval(turnId) {
	apprN += 1;
	const aid = "t50-a" + apprN;
	const req = { approvalId: aid, sourceIndex: 0 };
	const cmd = "ls -1 " + workspaceRoot;
	const p = {
		approvalId: aid,
		availableChoices: [
			{ choiceId: "allow_once", decision: "approved", label: "Allow once", scope: "once" },
			{
				choiceId: "allow_local_prefix",
				decision: "approvedPolicyAmendment",
				label: "Always allow in this workspace: ls ...",
				rulePreview: "Always allow in this workspace: ls ...",
				scope: "localPersistent",
			},
			{ acceptsFeedback: true, choiceId: "abort", decision: "abort", label: "Reject", scope: "once" },
		],
		currentRequirementId: req,
		itemId: aid,
		judgeEscalated: false,
		protectedWrite: false,
		rawArgs: JSON.stringify({ command: cmd, description: "List workspace files" }),
		sessionId: SESSION,
		sourceRange: srcRange(),
		subject: {
			kind: "shell",
			command: cmd,
			workspaceRoot: workspaceRoot,
			stages: [
				{
					argv: ["ls", "-1", workspaceRoot],
					argvComplete: true,
					position: 1,
					requirementId: req,
					resolution: { kind: "unresolved" },
					suggestedPrefix: { argvPrefix: ["ls"], label: "Always allow in this workspace: ls ..." },
					totalStages: 1,
				},
			],
		},
		taskId: aid,
		toolCallId: "call_t50a" + apprN,
		toolName: "bash",
		turnId: turnId,
		viewCursor: cursor(),
	};
	approvals.set(aid, p);
	logLine("EMIT-APPROVAL approvalId=" + aid + " turnId=" + turnId);
	serverRequest("approval/request", p);
	notify("approval/requested", p);
}

function singleQuestion() {
	return {
		header: "Indent",
		id: "indent_pref",
		options: [
			{ label: "Tabs", description: "Use tab characters for indentation." },
			{ label: "Spaces", description: "Use space characters for indentation." },
		],
		question: "Which do you prefer for indent: tabs or spaces?",
		selection: { mode: "single" },
	};
}

function multiQuestion() {
	return {
		header: "Shells",
		id: "shell_pref",
		options: [
			{ label: "bash", description: "Bourne again shell." },
			{ label: "zsh", description: "Z shell." },
			{ label: "fish", description: "Friendly interactive shell." },
		],
		question: "Which shells should the examples cover?",
		selection: { mode: "multiple", minSelections: 1, maxSelections: 2 },
	};
}

function makeQuestion(turnId, multi) {
	qN += 1;
	const qid = "t50-q" + qN;
	const p = {
		itemId: qid,
		questions: multi ? [singleQuestion(), multiQuestion()] : [singleQuestion()],
		sessionId: SESSION,
		sourceRange: srcRange(),
		toolCallId: "call_t50q" + qN,
		toolName: "request_user_input",
		turnId: turnId,
		userInputId: qid,
		viewCursor: cursor(),
	};
	questions.set(qid, p);
	logLine("EMIT-QUESTION userInputId=" + qid + " turnId=" + turnId + " n=" + p.questions.length);
	serverRequest("userInput/request", p);
	notify("userInput/requested", p);
}

function completeLive(terminal) {
	if (!liveTurn) return;
	const id = liveTurn;
	liveTurn = null;
	logLine("COMPLETE turnId=" + id + " terminal=" + terminal);
	notify("item/completed", {
		sessionId: SESSION,
		item: { kind: "agentMessage", itemId: id + "-msg", text: "t50 done (" + terminal + ")" },
	});
	notify("turn/completed", { sessionId: SESSION, turnId: id, terminal: terminal });
}

function maybeCompleteLive() {
	if (liveTurn && approvals.size === 0 && questions.size === 0) {
		completeLive("completed");
	}
}

rl.on("line", (text) => {
	if (dead) return;
	const trimmed = text.trim();
	if (!trimmed) return;
	let msg;
	try {
		msg = JSON.parse(trimmed);
	} catch {
		return;
	}
	// Client receipts (id, no method) and notifications (method, no id).
	if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
	const id = msg.id;
	const method = msg.method;
	const params = msg.params ?? {};
	if (method === "initialize") {
		const caps = params.capabilities ?? {};
		logLine("EXP experimentalApi=" + String(caps.experimentalApi === true));
		send({ jsonrpc: "2.0", id: id, result: {} });
		return;
	}
	if (method === "session/start") {
		workspaceRoot = String(params.workspaceRoot ?? "");
		liveProfile = String(params.permissionProfile ?? ":unrestricted");
		logLine("START session=" + SESSION + " approvalMode=" + String(params.approvalMode ?? "(none)") + " permissionProfile=" + String(params.permissionProfile ?? "(none)"));
		send({ jsonrpc: "2.0", id: id, result: { session: { sessionId: SESSION, permissionState: permState(liveProfile) }, viewCursor: "" } });
		return;
	}
	if (method === "session/setApprovalMode") {
		logLine("MODE " + String(params.mode));
		send({ jsonrpc: "2.0", id: id, result: {} });
		return;
	}
	if (method === "session/setPermissionProfile") {
		const want = String(params.profileId ?? "");
		logLine("PROFILE " + want);
		liveProfile = want;
		notify("session/permissionProfileChanged", {
			sessionId: SESSION,
			profileId: want,
			commandId: params.commandId,
			source: "livePicker",
			sourceRange: srcRange(),
			viewCursor: cursor(),
		});
		send({ jsonrpc: "2.0", id: id, result: { status: "accepted", commandId: params.commandId, applyOutcome: "completed", permissionState: permState(want) } });
		return;
	}
	if (method === "turn/start") {
		if (params.sessionId !== SESSION) {
			errTo(id, -32000, "session not loaded: " + String(params.sessionId), "sessionNotLoaded");
			return;
		}
		turnN += 1;
		const t = "t50-t" + turnN;
		liveTurn = t;
		const parts = Array.isArray(params.input) ? params.input : [];
		const textIn = parts
			.filter((p) => p && p.type === "text")
			.map((p) => p.text)
			.join("\n");
		logLine("RECV_TURN turnId=" + t);
		logLine("TURN_TEXT " + JSON.stringify(textIn));
		turns.push({ id: t, text: textIn });
		send({ jsonrpc: "2.0", id: id, result: { turnId: t, disposition: "started" } });
		notify("turn/started", { sessionId: SESSION, turnId: t });
		let held = false;
		if (textIn.includes("NEED-APPROVAL") || textIn.includes("NEED-BOTH")) {
			makeApproval(t);
			held = true;
		}
		if (textIn.includes("NEED-QUESTION") || textIn.includes("NEED-BOTH")) {
			makeQuestion(t, false);
			held = true;
		}
		if (textIn.includes("NEED-MULTI")) {
			makeQuestion(t, true);
			held = true;
		}
		if (!held) completeLive("completed");
		return;
	}
	if (method === "turn/interrupt") {
		const want = params.turnId;
		logLine("RECV_INTERRUPT turnId=" + String(want ?? "(unpinned)") + " live=" + String(liveTurn));
		if (!liveTurn || (typeof want === "string" && want !== liveTurn)) {
			send({
				jsonrpc: "2.0",
				id: id,
				error: {
					code: -32030,
					message: "turn/interrupt command rejected: missing_run",
					data: { kind: "commandRejected", retryable: false, reason: "missing_run" },
				},
			});
			return;
		}
		send({ jsonrpc: "2.0", id: id, result: { status: "accepted", turnId: liveTurn } });
		for (const [aid, cur] of approvals) {
			approvals.delete(aid);
			logLine("INTERRUPT-RESOLVED approvalId=" + aid);
			notify("approval/resolved", {
				approvalId: aid,
				decidedAt: new Date().toISOString(),
				decidedByCommandId: null,
				decision: "abort",
				itemId: cur.itemId,
				policyResult: "deny",
				resolvedBy: "user",
				sessionId: SESSION,
				sourceRange: srcRange(),
				stageEvidence: [],
				turnId: cur.turnId,
				viewCursor: cursor(),
			});
		}
		for (const [qid] of questions) {
			questions.delete(qid);
			logLine("INTERRUPT-SETTLED userInputId=" + qid);
			notify("userInput/settled", {
				answers: [],
				clarification: null,
				decidedAt: new Date().toISOString(),
				decidedByCommandId: null,
				outcome: "aborted",
				reason: "run_aborted",
				sessionId: SESSION,
				sourceRange: srcRange(),
				userInputId: qid,
				viewCursor: cursor(),
			});
		}
		completeLive("cancelled");
		return;
	}
	if (method === "approval/decide") {
		const aid = params.approvalId;
		logLine(
			"DECIDE approvalId=" +
				String(aid) +
				" choiceId=" +
				String(params.choiceId) +
				" requirementId=" +
				JSON.stringify(params.requirementId) +
				" commandId=" +
				String(params.commandId),
		);
		const cur = approvals.get(aid);
		if (!cur) {
			errTo(id, -32050, "unknown approval: " + String(aid), "approvalNotFound");
			return;
		}
		const want = params.requirementId ?? {};
		if (want.approvalId !== aid || want.sourceIndex !== cur.currentRequirementId.sourceIndex) {
			errTo(id, -32053, "stale requirementId", "staleRequirement");
			return;
		}
		const choice = cur.availableChoices.find((c) => c.choiceId === params.choiceId);
		if (!choice) {
			errTo(id, -32052, "unknown choice: " + String(params.choiceId), "unknownChoice");
			return;
		}
		approvals.delete(aid);
		const decision = choice.decision;
		const policy = decision === "abort" ? "deny" : "allow";
		notify("approval/updated", {
			approvalId: aid,
			availableChoices: cur.availableChoices,
			change: {
				choiceId: choice.choiceId,
				decision: decision,
				kind: "stageResolved",
				requirementId: cur.currentRequirementId,
			},
			currentRequirementId: cur.currentRequirementId,
			sessionId: SESSION,
			sourceRange: srcRange(),
			subject: cur.subject,
			viewCursor: cursor(),
		});
		notify("approval/resolved", {
			approvalId: aid,
			decidedAt: new Date().toISOString(),
			decidedByCommandId: params.commandId,
			decision: decision,
			itemId: cur.itemId,
			policyResult: policy,
			resolvedBy: "user",
			sessionId: SESSION,
			sourceRange: srcRange(),
			stageEvidence: [],
			turnId: cur.turnId,
			viewCursor: cursor(),
		});
		send({
			jsonrpc: "2.0",
			id: id,
			result: { commandId: params.commandId, approvalId: aid, status: "accepted", terminal: true },
		});
		maybeCompleteLive();
		return;
	}
	if (method === "userInput/answer") {
		const qid = params.userInputId;
		logLine("ANSWER userInputId=" + String(qid) + " answers=" + JSON.stringify(params.answers) + " commandId=" + String(params.commandId));
		const cur = questions.get(qid);
		if (!cur) {
			errTo(id, -32056, "unknown prompt: " + String(qid), "userInputNotFound");
			return;
		}
		questions.delete(qid);
		notify("userInput/settled", {
			answers: params.answers,
			clarification: null,
			decidedAt: new Date().toISOString(),
			decidedByCommandId: params.commandId,
			outcome: "answered",
			reason: null,
			sessionId: SESSION,
			sourceRange: srcRange(),
			userInputId: qid,
			viewCursor: cursor(),
		});
		send({ jsonrpc: "2.0", id: id, result: { commandId: params.commandId, status: "accepted", userInputId: qid } });
		maybeCompleteLive();
		return;
	}
	if (method === "userInput/cancel") {
		const qid = params.userInputId;
		logLine("CANCEL userInputId=" + String(qid) + " commandId=" + String(params.commandId));
		const cur = questions.get(qid);
		if (!cur) {
			errTo(id, -32056, "unknown prompt: " + String(qid), "userInputNotFound");
			return;
		}
		questions.delete(qid);
		notify("userInput/settled", {
			answers: [],
			clarification: null,
			decidedAt: new Date().toISOString(),
			decidedByCommandId: params.commandId,
			outcome: "cancelled",
			reason: typeof params.reason === "string" ? params.reason : null,
			sessionId: SESSION,
			sourceRange: srcRange(),
			userInputId: qid,
			viewCursor: cursor(),
		});
		send({ jsonrpc: "2.0", id: id, result: { commandId: params.commandId, status: "accepted", userInputId: qid } });
		maybeCompleteLive();
		return;
	}
	if (method === "approval/listPending") {
		send({
			jsonrpc: "2.0",
			id: id,
			result: { approvals: [...approvals.values()], userInputs: [...questions.values()] },
		});
		return;
	}
	if (method === "session/read") {
		const pending = [];
		for (const [aid, cur] of approvals) {
			pending.push({ kind: "approval", approvalId: aid, viewCursor: cur.viewCursor });
		}
		for (const [qid, cur] of questions) {
			pending.push({ kind: "userInput", userInputId: qid, viewCursor: cur.viewCursor });
		}
		send({
			jsonrpc: "2.0",
			id: id,
			result: { session: { sessionId: SESSION, permissionState: permState(liveProfile) }, history: [], lastTurn: null, pendingRequests: pending, viewCursor: cursor() },
		});
		return;
	}
	if (method === "view/page") {
		// T49 follow-up: history carries the real sent texts (preamble
		// included), so the server strip + chips path is exercised —
		// an empty history made the old no-preamble assertion vacuous.
		const events = turns.map((t) => ({
			method: "item/completed",
			params: {
				sessionId: SESSION,
				item: { kind: "userMessage", itemId: t.id + "-u", text: t.text },
			},
		}));
		send({ jsonrpc: "2.0", id: id, result: { events: events, nextCursor: null } });
		return;
	}
	if (method === "session/list") {
		// T49 follow-up: one canned past chat whose first prompt went
		// out targeted, so the /api/past title strip is exercised.
		const pastPrompt =
			"[routeros-muse context] target device: {\"id\":\"gw\",\"name\":\"gw\",\"host\":\"192.168.88.1\"}\n\nWhat did the past decide?";
		send({
			jsonrpc: "2.0",
			id: id,
			result: {
				sessions: [
					{ sessionId: SESSION, turnCount: turnN },
					{ sessionId: "t50-past1", turnCount: 1, firstUserPrompt: pastPrompt },
				],
			},
		});
		return;
	}
	if (method === "model/list") {
		send({
			jsonrpc: "2.0",
			id: id,
			result: { models: [{ modelId: "t50-fake", displayLabel: "t50-fake", isDefault: true }], providerId: "t50" },
		});
		return;
	}
	send({ jsonrpc: "2.0", id: id, result: {} });
});
`;

function writeShim(dir: string, name: string, body: string): void {
	const file = path.join(dir, name);
	nodeFs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
	nodeFs.chmodSync(file, 0o755);
}

/** Fronted PATH dir: T50 fake muse + shadow trilogy (all hermetic). */
export function stubT50Bin(): { bin: string; log: string } {
	const bin = mktmp("t50-bin-");
	const log = path.join(bin, "msp.log");
	nodeFs.writeFileSync(path.join(bin, "fake-muse-t50.ts"), T50_FAKE_MUSE);
	// T49: every spawn appends its argv ($*-joined) so tests can see
	// the trust flag. One line per worker spawn.
	const argvLog = path.join(bin, "argv.log");
	writeShim(
		bin,
		"muse",
		`printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}\n` +
			`exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(bin, "fake-muse-t50.ts"))} "$@"`,
	);
	// Trilogy shadows (same shape as tests/t71-fake.ts): the server
	// detects the CDB mode through `centrs devices list` at boot, so
	// ambient binaries must never resolve through the fronted PATH.
	writeShim(
		bin,
		"centrs",
		`if [ "$1" = "devices" ]; then\n` +
			`file=""; prev=""; for a in "$@"; do if [ "$prev" = "--cdb-file" ]; then file="$a"; fi; prev="$a"; done\n` +
			`if [ -n "$file" ] && [ -f "$file" ]; then\n` +
			`printf '%s\\n' '{"ok":true,"data":[],"warnings":[],"tips":[],"meta":{}}'\n` +
			`else\n` +
			`printf '%s\\n' '{"ok":false,"error":{"code":"cdb/not-found","summary":"CDB file not found"},"warnings":[],"tips":[],"meta":{}}'\n` +
			`fi\n` +
			`else\n` +
			`echo "stub-centrs 9.9.9-t50"\n` +
			`fi`,
	);
	for (const tool of ["quickchr", "rosetta"]) {
		writeShim(bin, tool, `echo "stub-${tool} 9.9.9-t50"`);
	}
	return { bin, log };
}

/**
 * Run fn with the fake-muse log env set (restored after). The fake
 * reads its config from the spawn env, which the server snapshots
 * from process.env at startup — so the server must start inside fn.
 */
export async function withT50Env<T>(
	log: string,
	fn: () => Promise<T>,
): Promise<T> {
	const saved = process.env["T50_LOG"];
	process.env["T50_LOG"] = log;
	try {
		return await fn();
	} finally {
		if (saved === undefined) delete process.env["T50_LOG"];
		else process.env["T50_LOG"] = saved;
	}
}

/** Minimal workspace (workspace.toml only; chat routes need no files). */
export function makeT50Workspace(): string {
	const dir = mktmp("t50-ws-");
	nodeFs.writeFileSync(path.join(dir, "workspace.toml"), "canonical = true\n");
	return dir;
}

export type T50SrvOpts = {
	defaultApprovalMode?: ApprovalMode;
	dataHome?: string;
	/** T101: isolated muse config home for approval-policy seeding. */
	configHome?: string;
	/** T101: caller-built workspace (default: minimal, no router.toml). */
	workspace?: string;
};

/** Bypass-mode server on the fake worker (no CDB file, no centrs). */
export async function startT50Srv(
	bin: string,
	extra?: T50SrvOpts,
): Promise<{ url: string; dataHome: string; stop: () => Promise<void> }> {
	const dataHome = extra?.dataHome ?? mktmp("t50-dh-");
	const srv = await startServer({
		dataHome,
		allowOpenCdb: true,
		workspace: extra?.workspace ?? makeT50Workspace(),
		provider: "echo",
		museHome: mktmp("t50-home-"),
		toolBinDir: bin,
		configHome: extra?.configHome ?? mktmp("t50-cfg-"),
		...(extra?.defaultApprovalMode
			? { defaultApprovalMode: extra.defaultApprovalMode }
			: {}),
	});
	return {
		url: srv.url,
		dataHome,
		stop: () => srv.stop(),
	};
}
