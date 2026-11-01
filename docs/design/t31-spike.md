# T31 spike — muse speaks MSP, not ACP (2026-11-01)

Hello-world vs `muse serve` (1.4.14, echo provider, orca). All run;
probes are session scratch at `/tmp/msp-spike*.py` (not committed).

## Headline

`muse` has no ACP surface (`--help`, `serve --help`, binary strings
all clean). Mode B's chat transport is MSP: `muse serve` over stdio,
newline-delimited JSON-RPC 2.0, schema exported offline via
`muse schema` (`msp.d.ts`, 4029 lines; fingerprint
`sha256:c94c3d1f…3049c6`). Filed as D22 (MSP-not-ACP).

## Wire facts (all observed)

- Frame: one JSON-RPC object per line, both directions. LSP-style
  `Content-Length` framing gets no reply.
- `initialize` ({clientInfo:{name,version}}) → result; then the
  client MUST send the `initialized` notification or every later call
  fails `notInitialized`.
- `session/start` needs UUIDv7 `commandId`; session id is
  `result.session.sessionId` (not `id`). Approval vocabulary is
  `allowAll | promptUnmatched | onRequest | denyUnmatched`
  (no `never`).
- Durable vs ephemeral matters: `--no-session-log` (memory-only)
  withholds `session/read`, `view/page`, `session/rename` as
  `methodNotFound`. Mode B must run the host durable (default).
- `session/compact` on echo rejects `compaction_unavailable`
  (no summarizer); schema says it may also answer `noop`.
  Needs one meta-provider run to confirm accept/noop.

## Assumption answers (the three T29 ACP bets)

1. Directory-scope tree → MSP gives `workspaceRoot(s)` on
   `session/start` (plural accepted) plus `@relative/path` file
   mentions inside text parts. No tree-serving method exists, which
   is fine: the Bun server reads the tree from disk (it only ever
   sees files) and the agent sees the workspace via its root.
2. Attachments → WORKING, no fallback needed. `image` part with
   base64 PNG accepted; echo renders `[Image #1]`; malformed
   payload cleanly rejected `invalidParams`. (`video` via
   `media/upload` receipt; untested, same shape.)
3. Agent-driven alert injection → NOT `turn/steer` after the fact
   (refused `already_terminal`; steer is running-turn-only, and
   interrupt-when-idle is `missing_run`, which defines the Stop
   button's idle behavior). Injection rides the settled principle:
   the agent writes alert/topology files in the workspace and the
   server watches them — consistent with "agent manages display
   state via topology files" from the T32 approval.

## Also confirmed

- `session/list` indexes past chats across clients (saw this T3
  session's own row); `view/page` backward pages bodies (20 events,
  typed methods incl. `session/tokenUsage`, `session/contextUsage`
  for the stats popover); `session/rename` durable-names a past
  (agent-titled pasts work).
- `skill/list` serves the skill catalog (run-controls surface).

## Left for the meta-provider run (T31 build time, costs API)

Compact accept/noop, `@mention` grounding, tool use + workspace
file writes (the alert-injection file path), live steer into a
running turn. None blocks starting the Bun server + MSP client;
the echo-verified surface above is the build contract.
