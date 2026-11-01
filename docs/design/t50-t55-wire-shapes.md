# T50/T55 wire shapes — live `meta` captures (2026-11-01)

Research for T50 (approval/question surface) and T55 (skill loading +
UI-action plumbing). Every claim below comes from a wire capture or a
binary-exported schema, never memory.

- `muse --version`: `Muse Code 1.4.14 (1.4.14-R7309.1)`
- Capture dir (main checkout, gitignored, never committed):
  `out/wire-capture/20261101T210403Z/`
- Capture tool (committed): `tools/msp-capture.ts` — Bun, zero deps.
  Speaks JSONL JSON-RPC over `muse serve` stdio exactly like
  `src/msp/client.ts`, logs every frame both directions with ISO
  timestamps (`C>` client→server, `S>` server→client, `S!` server stderr).
- Provider: real `meta` (`model/list` → `muse-spark-1.3-contributor`).
- Isolation: `XDG_DATA_HOME` pointed at a temp dir so probe sessions never
  touch the real session log; `XDG_CONFIG_HOME` left intact (meta auth).
- Workspaces: temp dir `/dev/shm/wire-20261101T210403Z/` (deleted after),
  `ws-net` from `bun src/index.ts init <dir> --template network`,
  `ws-min` from `--template minimal`.
- Schema: `muse schema generate-ts` / `generate-json-schema`, stable and
  `--experimental`, exported offline into the stamp dir (`schema-ts/`,
  `schema-json/`, `schema-ts-exp/`, `schema-json-exp/`). Fingerprint
  `sha256:c94c3d1f…3049c6` (matches the T31 spike).

All commands below run from the repo root. `--muse-home` = the temp
`XDG_DATA_HOME`; `--workspace` = the temp workspace.

## Capture inventory

| File | Command (abridged) | What it proves |
|---|---|---|
| `01-session-probe-net-notrust.jsonl` | `session-probe` net, untrusted | initialize result; 34 skills, 0 project |
| `02-session-probe-net-trust.jsonl` | `session-probe` net + `--trust-workspace` | trust alone adds nothing (template `skills/` ignored) |
| `03-session-probe-agents-skills.jsonl` | trusted + `.agents/skills/probe-skill/` | 35 rows, 1× `[project]` |
| `04-session-probe-agents-skills-notrust.jsonl` | untrusted + `.agents/skills/` | back to 34 rows (trust-gated) |
| `05-auth-ping.jsonl` | `turn` PONG, no tools | minimal turn frame sequence |
| `06-a1-ls-approve.jsonl` | `turn` ls, onRequest, `--approve=once` | A1: NO approval under onRequest |
| `07-a2-write-approve.jsonl` | `turn` write notes.txt, onRequest | A2: NO approval; file created |
| `08-ls-promptunmatched.jsonl` | `turn` ls, promptUnmatched, approve | full approve flow + payloads |
| `09-ls-deny.jsonl` | `turn` ls, promptUnmatched, deny | abort flow; agent self-asked a question; interrupt→cancelled |
| `10-ls-never.jsonl` | `turn` ls, promptUnmatched, never+interrupt | 3.4 min pending, no auto-settle |
| `11-rm-onrequest.jsonl` | `turn` rm notes.txt, onRequest | even `rm` runs unprompted |
| `12-a3-ask-answer.jsonl` | `turn` tabs-vs-spaces, `--answer=first` | full question round trip |
| `13-b1-net-untrusted.jsonl` | `turn` list instructions/skills, net untrusted | B1: nothing project-local loaded |
| `14-b1-net-trusted.jsonl` | same, net trusted | B1: AGENTS.md + 1 project skill |
| `15-b1-min-trusted.jsonl` | same, minimal trusted | B1: AGENTS.md, 0 project skills |
| `16-session-probe-min-notrust.jsonl` | `session-probe` minimal untrusted | 34-row baseline |
| `17-b2-mcp-roundtrip.jsonl` | `turn` + `--capabilities=sessionMcp` + `--mcp-config 14-mcp-config.json` | B2: MCP tool round trip (approval kind `tool`) |
| `14-mcp-config.json` | session/start `config.mcpServers` input | stdio MCP server wiring |
| `14-mcp-server.jsonl` | MCP shim log (last line only — see B2) | `tools/call` result `noted: hello from agent` |

## A1. `ls` under approvalMode=onRequest

**Answer: muse emits nothing approval-shaped. The `bash` tool runs
unprompted (`approvalId: null` on every item) and the turn completes.**
Approve / deny / never-answer therefore only exist where approvals fire;
all three were captured under `promptUnmatched` instead (same wire
shapes — B2 shows an onRequest approval uses the identical frames).

Command (no approval fired):

```sh
bun tools/msp-capture.ts turn --provider meta \
  --workspace /dev/shm/wire-20261101T210403Z/ws-min \
  --muse-home /dev/shm/wire-20261101T210403Z/muse-home \
  --out out/wire-capture/20261101T210403Z/06-a1-ls-approve.jsonl \
  --prompt="Run the command 'ls' in the workspace and report the filenames. Do not access the network." \
  --approve=once --timeout-ms=300000
```

Excerpt (`06-a1-ls-approve.jsonl`): the tool ran with no `approval/*`
frame anywhere in the 16 s turn:

```json
{"t":"...","dir":"S>","frame":{"jsonrpc":"2.0","method":"item/completed",
 "params":{"item":{"kind":"toolCall","tool":"bash","approvalId":null,
 "status":"completed","args":"{\"command\":\"ls\",\"description\":\"List workspace files\"}"}, ...}}}
```

Methods seen: `item/*`, `session/approvalModeChanged`, `session/started`,
`session/statusChanged`, `session/tokenUsage`, `turn/started`,
`turn/foregroundCompleted`, `turn/completed`. No `SR:approval/request`.

### Where approvals DO fire: promptUnmatched approve/deny/never

Same prompt with `--approval-mode=promptUnmatched`:

**What muse emits.** A server-initiated JSON-RPC *request* (own small-id
counter, unrelated to client ids), then a notification twin:

```
S> approval/request            (id=1, method+params; params.approvalId is the stable id)
C> {"jsonrpc":"2.0","id":1,"result":{}}            (presentation receipt: ack only, decides nothing)
S> approval/requested          (same params + viewCursor; readable later via view/page)
```

Excerpt (`08-ls-promptunmatched.jsonl`, `sourceRange` omitted):

```json
{"approvalId":"01a198fd-4d27-77e3-ace7-e98aeba90b4b",
 "availableChoices":[
  {"choiceId":"allow_once","decision":"approved","label":"Allow once","scope":"once"},
  {"choiceId":"allow_local_prefix","decision":"approvedPolicyAmendment",
   "label":"Always allow in this workspace: ls ...","scope":"localPersistent",
   "rulePreview":"Always allow in this workspace: ls ..."},
  {"acceptsFeedback":true,"choiceId":"abort","decision":"abort","label":"Reject","scope":"once"}],
 "currentRequirementId":{"approvalId":"01a198fd-4d27-77e3-ace7-e98aeba90b4b","sourceIndex":0},
 "itemId":"01a198fd-4d27-77e3-ace7-e98aeba90b4b",
 "subject":{"kind":"shell","command":"ls -1 /dev/shm/wire-20261101T210403Z/ws-min",
  "workspaceRoot":"/dev/shm/wire-20261101T210403Z/ws-min",
  "stages":[{"argv":["ls","-1","/dev/shm/wire-20261101T210403Z/ws-min"],"position":1,...}]},
 "toolName":"bash","turnId":"01a198fd-3e3e-7331-9764-9571453cf555", ...}
```

**What reply it expects.** The decision travels as a separate command —
clients never invent choices, they echo one `choiceId`:

```
C> approval/decide  {commandId, sessionId, approvalId, requirementId, choiceId}
S> approval/updated   (change.kind=stageResolved, refreshed choices)
S> approval/resolved  (decision, resolvedBy, policyResult)
S> RESPONSE(status=accepted, terminal=true)
```

**On approve** (`08`, `choiceId=allow_once`): `approval/resolved`
`decision=approved, resolvedBy=user, policyResult=allow`; the `bash`
toolCall ran, `ls` output streamed via `item/delta` (`field=output`),
turn `terminal=completed`.

**On deny** (`09-ls-deny.jsonl`, `choiceId=abort` — there is NO
`denied` choice for shell; Reject maps to `abort`):
`approval/resolved` `decision=abort, policyResult=deny,
resolvedBy=user`. The turn did NOT die: the agent narrated the
rejection and then asked its own `userInput/request` (see A3).

**On never-answer** (`10-ls-never.jsonl`): the approval sat pending
3.5 min (`approval/listPending` → `approvals=1`, no auto-settle, no
timeout frame), then `turn/interrupt` resolved it:
`approval/resolved` `decision=abort, policyResult=deny,
resolvedBy=user` (no `decidedByCommandId` on the interrupt path) and
`turn/completed` `terminal=cancelled,
reason="cancelled after tool result reconciliation"`.

**OnRequest is permissive, not broken.** `11-rm-onrequest.jsonl`:
`rm notes.txt` (via `bash`, `approvalId: null`) also ran unprompted and
deleted the file. The one onRequest approval observed in the whole
campaign was an MCP tool call (B2), which uses identical frames with
`subject.kind=tool`.

## A2. File write under onRequest

**Answer: same as A1 — no approval. The `write_file` tool ran with
`approvalId: null` and `notes.txt` landed with the exact content.**

Command:

```sh
bun tools/msp-capture.ts turn --provider meta \
  --workspace /dev/shm/wire-20261101T210403Z/ws-min \
  --muse-home /dev/shm/wire-20261101T210403Z/muse-home \
  --out out/wire-capture/20261101T210403Z/07-a2-write-approve.jsonl \
  --prompt="Create a file named notes.txt in the workspace containing exactly the line 'wire-shape probe ok'. Do not access the network." \
  --approve=once --timeout-ms=300000
```

Excerpt (`07-a2-write-approve.jsonl`):

```json
{"item":{"kind":"toolCall","tool":"write_file","approvalId":null,"status":"completed",
 "args":"{\"content\":\"wire-shape probe ok\\n\",\"path\":\"notes.txt\"}"}}
```

Verified on disk: `notes.txt` = `wire-shape probe ok`. (Later removed
by the `11` rm probe, same temp dir.)

## A3. Agent asking the user a question

**Answer: yes — the `request_user_input` tool, over MSP as
server-initiated `userInput/request`, answered via `userInput/answer`.
It is agent-driven and fires under onRequest too (no approval mode
involved).** The agent also self-triggered one after the A1 deny.

Command (scripted answer: first option of every question):

```sh
bun tools/msp-capture.ts turn --provider meta \
  --workspace /dev/shm/wire-20261101T210403Z/ws-min \
  --muse-home /dev/shm/wire-20261101T210403Z/muse-home \
  --out out/wire-capture/20261101T210403Z/12-a3-ask-answer.jsonl \
  --prompt="Before proceeding, ask me which of two options I prefer: tabs or spaces for indent. Then write my choice into pref.txt in the workspace. Do not access the network." \
  --answer=first --approve=once --timeout-ms=300000
```

Wire sequence (`12-a3-ask-answer.jsonl`):

```
S> userInput/request           (id=1; params.userInputId is the stable id)
C> {"jsonrpc":"2.0","id":1,"result":{}}            (presentation receipt)
S> userInput/requested         (notification twin + viewCursor)
C> userInput/answer {commandId, sessionId, userInputId, answers:[{questionId, selectedLabel}]}
S> RESPONSE {commandId, status=accepted, userInputId}
S> userInput/settled           (outcome=answered, answers echoed)
... agent wrote pref.txt ("Tabs"), turn terminal=completed
```

Request excerpt (`sourceRange` omitted; note: NO `autoResolutionMs`
member — see below):

```json
{"itemId":"01a19910-e42a-7e93-9eab-5591a63f9872",
 "questions":[{"header":"Indent","id":"indent_pref",
  "options":[{"label":"Tabs","description":"Use tab characters for indentation."},
             {"label":"Spaces","description":"Use space characters for indentation."}],
  "question":"Which do you prefer for indent: tabs or spaces?",
  "selection":{"mode":"single"}}],
 "toolName":"request_user_input","turnId":"01a19910-c7d6-7710-ba16-2f129a7d538f",
 "userInputId":"01a19910-e42a-7e93-9eab-5591a63f9872", ...}
```

Expected answer shape (sent, accepted): one entry per question —
`{questionId, selectedLabel}` for `single`,
`{questionId, selectedLabels[]}` for `multiple`, or `{questionId,
freeText}`; optional `note` (all ≤500 chars). Settled excerpt:

```json
{"answers":[{"questionId":"indent_pref","selectedLabel":"Tabs"}],
 "outcome":"answered","decidedByCommandId":"01a19910-ea10-7871-a918-616bc0b1856a",...}
```

**Never-answer** (`09-ls-deny.jsonl`, agent self-asked `retry-ls`
question after the deny): still pending after 6.5 min
(`approval/listPending` → `userInputs=1` at the 5 min mark), then
`turn/interrupt` settled it: `userInput/settled` `outcome=aborted,
reason=run_aborted, decidedByCommandId=null`, turn
`terminal=cancelled`. Both observed prompts omitted `autoResolutionMs`,
so no `timedOut` path was exercisable (schema: settle-as-`timedOut`
after `autoResolutionMs × questionCount` when present).
`userInput/cancel` (→ model-visible cancellation) and
`userInput/clarify` were not exercised live; shapes are per schema.

## A4. What our onStream handlers drop

Two layers (read 2026-11-01; line numbers are that day's):

- **Server** (`src/serve/server.ts` `ensureMsp` notification tap):
  forwards **everything** to SSE — `item/started|updated|completed` get a
  `transcriptItems` row attached, `turn/completed`,
  `session/contextUsage`, `session/tokenUsage` update server-side
  tracking, and every other method is re-emitted verbatim. No transport
  work needed for T50 (agrees with the T62 re-sweep).
- **UI** (`src/serve/ui.html` `onStream`) handles exactly:
  `turn/started`, `meta/authChanged` (server-synthesized),
  `turn/completed`, `item/started`, `item/completed|updated`,
  `item/delta`. **Everything else falls through with no branch** —
  observed-live drops include `approval/requested|updated|resolved`,
  `userInput/requested|settled`, `session/started|statusChanged|
  approvalModeChanged|tokenUsage|closed`, `turn/foregroundCompleted`.
  `transcriptItems` additionally renders approval-gated toolCalls as
  inert tool cards: the wire `toolCall` items carry `approvalId: null`
  even when gated (join key is `approval.request.itemId == item.itemId`,
  identical IDs in captures 08/09/17) — there is no approval affordance
  and no row for the approval itself.

So today an approval or question waits forever with no UI: the frames
arrive at the browser (SSE) and die in `onStream`.

## B1. Instructions, skills, and what a session picks up

**Answer: project instructions and skills load from fixed workspace
paths, gated on the `--trust-workspace` host flag — nothing on the wire
selects them. The network template's `skills/` layout is invisible to
muse; project skills live at `.agents/skills/<name>/SKILL.md`.**

Grounded matrix (free `skill/list` probes + one model turn each;
counts are per-capture — a 35th user skill, `routeros-zerotier`, was
symlinked into `~/.agents/skills` by another process mid-campaign and
appears in zero captures):

| Workspace | Trust | `skill/list` rows | Agent report (turn) |
|---|---|---|---|
| network | no (`01`) | 34 (bundled+user+plugin, 0 project) | "No project rules file loaded. No project skills loaded … skipped because workspace is untrusted" (`13`) |
| network | yes (`02`) | 34 (template `skills/` ignored) | — |
| network + `.agents/skills/probe-skill/` | yes (`03`) | 35, +`change-apply [project]` | AGENTS.md loaded as project rules; Project (1): `change-apply` (`14`) |
| same | no (`04`) | 34 (withheld) | — |
| minimal | no (`16`) | 34 baseline | — |
| minimal | yes (`15` turn) | — | minimal AGENTS.md loaded; project skills: none |

Commands (probe shape; turns add `--prompt="List the instructions and
skills you can see. ..."`):

```sh
bun tools/msp-capture.ts session-probe --provider meta \
  --workspace /dev/shm/wire-20261101T210403Z/ws-net \
  --muse-home /dev/shm/wire-20261101T210403Z/muse-home \
  --serve-args="--trust-workspace" \
  --out out/wire-capture/20261101T210403Z/03-session-probe-agents-skills.jsonl
mkdir -p <ws-net>/.agents/skills/probe-skill   # staged before 03/04
cp <ws-net>/skills/change-apply/SKILL.md <ws-net>/.agents/skills/probe-skill/SKILL.md
```

Key evidence:

- `muse init --dry-run` prints an AGENTS.md scaffold: "Muse Code reads
  this file as project rules when it runs in this directory" — but per
  the untrusted turn, only when trusted.
- `initialize` result (`01`) carries no instruction/skill surface:
  `{experimentalApi, grantedCapabilities, museHome, platformFamily,
  platformOs, sandboxAvailability, schema, serverInfo,
  sessionDurability, userAgent}`.
- `session/start` params admit no instructions/system-prompt/skill-dirs
  (schema `SessionStartParams`: approvalMode, commandId, config
  [mcpServers only], modelId, permissionProfile, previousSessionId,
  providerId, recoveryMode, sessionId, spawnedBy, workspaceRoot(s)).
  The served `Session` object likewise carries none (`17`-probe keys:
  activeTurnId, approvalMode, createdAt, createdByClient, forkedFrom,
  kind, modelId, path, providerId, sessionId, sideFrom, status,
  turnCount, updatedAt, workspaceRoot).
- `hook/list` on trusted ws-net: `{"hooks": []}` (nothing else
  discovered; template ships no hooks).
- Our server spawns `muse serve` WITHOUT `--trust-workspace` today
  (`MspClient.spawn` in `ensureMsp` passes no `extraArgs`), so a
  network-template workspace behind our UI loads neither its AGENTS.md
  nor any project skill — capture `13` is exactly that configuration.

## B2. Host-registered tools the agent can call

**Answer: no dynamic/client-tool registration exists on the wire
(stable or experimental — no `clientTool`/`dynamicTool`/`registerTool`
in either schema). The mechanism is per-session MCP servers:
`initialize` negotiates the `sessionMcp` capability, then
`session/start` passes `config.mcpServers`. Full round trip captured
with a trivial `ui_show_note(text)` stdio server
(`mcp-server` mode of the capture tool).**

Without the capability, the host refuses the config (observed):

```json
{"error":{"code":-32010,"message":"session MCP configuration requires the sessionMcp capability",
 "data":{"kind":"capabilityRequired"}}}
```

Command:

```sh
bun tools/msp-capture.ts turn --provider meta \
  --workspace /dev/shm/wire-20261101T210403Z/ws-min \
  --muse-home /dev/shm/wire-20261101T210403Z/muse-home \
  --capabilities=sessionMcp \
  --mcp-config out/wire-capture/20261101T210403Z/14-mcp-config.json \
  --out out/wire-capture/20261101T210403Z/17-b2-mcp-roundtrip.jsonl \
  --prompt="Call the ui_show_note tool with text 'hello from agent'. Report exactly what it returned. Do not access the network." \
  --approve=once --timeout-ms=300000
```

`14-mcp-config.json` (sent as `config.mcpServers`):

```json
{"wire-probe":{"transport":"stdio","command":"bun",
 "args":["<worktree>/tools/msp-capture.ts","mcp-server"],
 "env":{"CAPTURE_MCP_LOG":".../20261101T210403Z/14-mcp-server.jsonl"}}}
```

Round trip (`17-b2-mcp-roundtrip.jsonl` + `14-mcp-server.jsonl`):

1. `initialize` with `capabilities.requestedCapabilities=["sessionMcp"]`
   → `grantedCapabilities: ["sessionMcp"]`.
2. `session/start` with the config → accepted (no error).
3. Agent called `mcp__wire_probe__ui_show_note` — note the namespacing
   `mcp__<server>__<tool>`, and note it fired an `approval/request`
   with `subject={"kind":"tool","toolName":"mcp__wire_probe__ui_show_note"}`
   and `rawArgs={"text":"hello from agent"}` **even under onRequest**.
   Tool-kind choices differ from shell-kind: `allow_once`,
   `allow_session` (approvedForSession), `allow_local_mcp_tool`
   (approvedPolicyAmendment), `abort`.
4. `approval/decide allow_once` → resolved → MCP `tools/call` → result
   `{"content":[{"type":"text","text":"noted: hello from agent"}]}`
   (host-side line in `14-mcp-server.jsonl`) → agent reported
   `noted: hello from agent` verbatim → turn completed.

Caveat: the shim's per-line `Bun.write` log truncated to the last line
in this run (fixed to sync append after; verified 4 lines/2 responses
in a retest), so only the final `tools/call` result line survives
host-side. The MSP side is complete.

Closest alternatives if MCP is too heavy: none on the wire — the
agent-writes-files-the-UI-watches pattern (T31 spike §3) remains the
only other grounded channel.

## B3. MSP method and notification surface

Authoritative lists are the exported schema's `MspMethod`,
`MspNotification`, `MspServerRequest` (`schema-ts/msp.d.ts`, 1.4.14).
Live-observed marks (✓) are from this campaign's captures.

**Client→server methods, stable (70).** ✓ = exercised live here or by
the running server (per T31/T37 evidence); the rest are
schema/help-documented only.

- Session/turn: ✓`initialize`, ✓`session/start`, `session/resume`,
  `session/fork`, `session/leave`, ✓`session/list`, `session/read`
  (probed ad-hoc: `{history, lastTurn, pendingRequests, session,
  viewCursor}`), `session/sideChat`, ✓`turn/start`, `turn/steer`,
  ✓`turn/interrupt`, `turn/cancel`, `turn/unqueue`, `session/compact`,
  ✓`session/setModel`, `session/rename`, ✓`session/setReasoningEffort`,
  `session/userShell` (needs `userShell` capability), ✓`model/list`
- Skills/hooks/plugins: ✓`skill/list`, `skill/setActivation`,
  `skill/import`, `hook/list` (probed: `{"hooks":[]}`), `plugin/list`,
  `plugin/install`, `plugin/marketplaceAdd|Update|Remove`
- Tasks/goals/workflows: `task/background|stop|stopAll|list`,
  `goal/set|edit|clear|pause|resume`, `workflow/cancel|childControl|
  pause|resume`
- Views/items: `view/subscribe|unsubscribe`, ✓`view/page`,
  ✓`item/readOutput`, `media/upload`
- Approvals/input: ✓`approval/decide`, ✓`approval/listPending`,
  `session/setApprovalMode`, ✓`userInput/answer`, `userInput/cancel`,
  `userInput/clarify`, `userInput/interrupt`
- Misc: `usage/read`, `feedback/submit`, `recap/request|cancel`,
  `computerUseSettings/read|update`, `computerUseSetup/read|start|check`
- Subagents: `subagent/sendMessage|followupTask|interrupt|stop|resume|
  reopen|close|readResult`

**Server→client requests (expect `{}` receipt + command):**
✓`approval/request`, ✓`userInput/request`.

**Server→client notifications, stable (45).** Observed ✓:
`session/started|closed|statusChanged|approvalModeChanged|tokenUsage`,
`turn/started|completed|foregroundCompleted`,
`item/started|delta|updated|completed`,
`approval/requested|updated|resolved`,
`userInput/requested|settled`. Notably NEVER observed this campaign:
`session/contextUsage` (no pressure change on short turns),
`approval/reviewing` (no LLM judge), `userInput/engaged`.
Unexercised: `session/leaveCompleted`, `skill/changed`, `turn/retracted|
retryScheduled|modelRetryScheduled|unqueued`, `view/gap`,
`session/modelChanged|reasoningEffortChanged|goalChanged|
todoListChanged|branchChanged|modelRouteUnserved|nameChanged|
viewHealthChanged|listChanged`, `usage/changed`,
`computerUseSetup/changed`, `plugin/changed|marketplaceChanged`,
`monitor/inboxItemAdmitted|Drained|Voided`.

**Experimental-only** (exported, not exercised): 35 more methods —
`settings/read|readSchema|writeMany|writeValue`, `mcpServer/list|
oauthLogin|oauthLoginCancel|oauthLogout`, `permissionProfile/list`,
`session/setPermissionProfile`, `session/promptHint`,
`session/requestDrive|releaseDrive|reportStartupPhases`,
`admission/decide|listPending`, `account/*`, `peer/*`, `log/*`,
`projection/*`, `host/readLimits`, `session/readLimits`,
`usage/refresh`, `worktree/list` — plus 12 notifications and a third
server request `admission/request`. `session/promptHint` and
`settings/writeValue` are the obvious future skill/instruction
channels; both need an experimental-API client and live verification.

**Help-documented but not exercised:** `muse serve` flags
`--disable-request-user-input` (withholds the question tool),
`--disable-sandbox`, `--sandbox-network`, `--disable-write`,
`--disable-shell`, `--trust-workspace` (exercised re: skills),
`--listen` socket daemon; `muse skills|mcp|auth|login|usage` CLIs.

## Implications

**T50 approval/question surface — build on:**

- The only client→server writes needed: `approval/decide`
  (choiceId echoed from the request, never invented, plus the
  `requirementId` race guard) and `userInput/answer` (plus
  `userInput/cancel` for decline). Receipts (`{}`) are already handled
  by `src/msp/client.ts`'s server-request arm — correct per the
  presentation-receipt contract; keep it and surface the payload.
- Render from `approval/requested` / `userInput/requested`
  (notification twins, durable `viewCursor`s), not from the
  server-request frames: requests are per-connection (small ids,
  re-issued on resume), the `approvalId`/`userInputId` is the stable
  key. Late joiners recover via `approval/listPending` +
  `session/read.pendingRequests` + `view/page` at the cursor.
- Choice sets differ by subject kind (shell: allow_once /
  allow_local_prefix / abort; MCP tool: allow_once / allow_session /
  allow_local_mcp_tool / abort) and the reject path is `abort`, not
  `denied` — the UI must not assume a fixed button set; render
  `label`/`rulePreview` verbatim and key behavior off `decision`.
- Never-answer is the normal stuck state: no auto-settle without
  `autoResolutionMs` (absent in both observed prompts), so the UI must
  show pending approvals/questions prominently with an interrupt
  escape hatch; `turn/interrupt` aborts both (approval→`abort/deny`,
  question→`aborted/run_aborted`, turn→`cancelled`).
- Scope surprise: under the server's `onRequest` default, workspace
  shell (incl. `rm`) and file writes run approval-free; MCP tools
  still prompt. If T50 wants approvals for everyday commands, the
  session must run `promptUnmatched` (or the denying
  `denyUnmatched`) — a mode decision, not just a surface build.
- Join approvals to transcript rows via `request.itemId == item.itemId`;
  `item.approvalId` is `null` on the wire even when gated.

**T55 skill-loading / UI-action plumbing — build on:**

- Skills: pass `--trust-workspace` to the MSP host AND move (or mirror)
  template skills to `.agents/skills/<name>/SKILL.md` — the template's
  `skills/` tree is dead weight to muse as shipped. AGENTS.md at the
  workspace root then loads as project rules automatically. No
  session/start params exist for instructions; trust is the whole knob.
  Trust also loads hooks — audit what else a workspace can inject
  before enabling it for untrusted trees.
- UI actions: per-session MCP (`sessionMcp` capability +
  `config.mcpServers` at `session/start`) is the one grounded
  agent-callable-host-tool channel; names arrive as
  `mcp__<server>__<tool>`. Budget an approval per first call
  (MCP tools prompt even under onRequest — a feature for UI actions).
  File-watching stays the fallback for agent→UI display state.

**Upstream muse gaps / questions worth filing:**

1. `onRequest` semantics are undiscoverable: nothing on the wire or in
   `--help` says workspace shell/file tools run free while MCP tools
   prompt. A `permissionProfile/list`-style readable policy, or mode
   docs, would remove the guesswork.
2. `item.approvalId` is documented as the approval join key but is
   `null` on gated toolCalls (3/3 captures); the real join is
   `request.itemId`. Either populate it or correct the schema doc.
3. `sessionMcp` is granted but otherwise undocumented in the stable
   schema (only the capability-registry line); the
   `config.mcpServers`-requires-capability error is the only guide.
4. No stable per-session instruction/system-prompt/skills channel —
   everything hangs off the host-level `--trust-workspace` flag, which
   is all-or-nothing per host. Experimental `session/promptHint` may
   be the answer; needs verification once stable.

## What was NOT determined

- `denyUnmatched` behavior and the `approvedForSession` / policy-amendment
  (`allow_local_prefix`, `allow_local_mcp_tool`) persistence effects —
  no live runs (each is a turn + policy-store inspection).
- The `userInput` `timedOut` path (`autoResolutionMs` was absent in both
  prompts), `userInput/cancel|clarify|interrupt` live behavior, and
  multi-question / `multiple`-selection answer acceptance.
- `approval/reviewing` (LLM-judge) flow — no judge is configured in this
  environment.
- Whether `session/contextUsage` ever fires on `meta` (absent in all 13
  turns; only `session/tokenUsage` observed).
- `session/compact` accept/noop on meta (still open from the T31 spike).
- Any instruction source beyond AGENTS.md + `.agents/skills` + hooks
  (e.g. memory dirs, `.muse/` paths) — not probed.
- MCP `streamableHttp` transport and `optional`-mode servers — stdio
  only.
- Everything experimental (`session/promptHint`, `settings/*`,
  `admission/*`, …) — exported, never exercised.



