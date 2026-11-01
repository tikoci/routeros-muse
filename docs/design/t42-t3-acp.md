# T42 — t3code ACP/agent research (2026-11-01)

Subagent sweep of `https://github.com/pingdotgg/t3code` at commit
`6328c847` (clone at `/tmp/t42-acp`, session scratch). Full report in
the session tool-outputs (`subagent-2-subagent_result.txt`). Feeds T41
(renderer) and T39 (auth); corrects our "ACP" vocabulary below.

## Critical identity split (byte-verified by the child)

- `claude-acp` / `claude-agent-acp` = **Anthropic's** Claude agent
  over generic ACP. This is "Muse over ACP".
- `packages/provider-muse/` ("Muse Code", `muse` binary,
  `providerId: "meta"`) = **Meta's** Muse over MSP via
  `@muse-code/sdk` — a native non-ACP provider. This is OUR path.
- `ClaudeDriver.ts` = legacy native `Muse` CLI driver, no ACP.

So t3code does not speak ACP to Muse either. Our MSP bridge matches
their architecture; their `provider-muse` is the file-for-file
reference, and generic ACP transport patterns apply only if we ever
add non-Muse agents.

## provider-muse items worth copying (all MIT)

- Turn wiring + `session/contextUsage` → `{usedTokens,
  maxTokens: windowTokens}` (`adapter.ts:1951-2094, 1309-1319`) —
  same computation we shipped in T36.
- `model/list` on a readOnly host, 8s timeout, catalog must say
  `providerId: "meta"` (`modelCatalog.ts:96-140`).
- `session/setModel{modelId, providerId: "meta"}` — they pass
  providerId too; we pass modelId only. Retry with providerId if
  meta ever rejects our shape.
- Subscription quota `MuseSubscriptionUsage{tier, window{
  usedPercent, resetsAtMs}, weekly{...}}` (`protocol.ts:139-183`)
  — candidate for our stats popover.
- Transcript-mined usage from `<museHome>/sessions/session.jsonl`
  `model_completed` events (`usage.ts:20-115`) — complements live
  events for stats.
- Reasoning tiers + per-turn `reasoningEffort`; `museApprovalMode`
  mapping (full-access→allowAll else promptUnmatched).

## Auth: no passive detection exists (drives T39)

MSP has **no auth signal**: cached models serve while logged out,
failures surface on first turn, t3code shows auth `unknown`
forever (`status.ts:135`). Their ACP side likewise probes with a
disposable session rather than detecting passively. Our D24
"OAuth-gated chat" therefore needs an **active probe** (cheap turn
or model-route check), not a state read. Also copy: binding-hash
persisted sign-in state, per-method guidance strings, defensive
caps at trust boundaries (256 models, 32 methods, …).

## Generic ACP patterns (only if we add ACP agents later)

`_t3_unknown` forward-compat envelope, v1/v2 shape-sniffed
negotiation, `-32000` authenticate-once-and-retry with headless
fail-fast, capability-driven settings UI, `thought_level` →
reasoning control.
