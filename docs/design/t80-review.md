# T80 verification evidence — 2026-11-01

The implementation foundation is advancing, and the current gate is green.
The next milestone needs correctness repairs and a complete operator workflow.
Task numbers and a green echo-provider suite do not establish the D16 real-agent
demonstration or the D17 artifact-display requirement. Findings, follow-ups,
priorities and proposed rulings are recorded in `records/*.toml`; this file is
their supporting evidence, not a second tracker.

## Verification scope

Executed against the current local prototype, without changing product code:

| Command | Observed result |
| --- | --- |
| `cd proto/routeros-muse && TMPDIR=/dev/shm make gate` | Exit 0; Biome and tsc pass; 164 tests pass, 0 fail; 56 browser checks pass; no unexpected console errors |
| `make -C records check` | Valid after the review changes: 29 needs, 89 tasks, 33 decisions, 29 concepts |
| `TMPDIR=/dev/shm bun notes/t80-lifecycle-probe.ts` | Real echo MSP: first owner send succeeds; next unlock owner's first send returns 400/sessionNotLoaded; retry succeeds |
| `TMPDIR=/dev/shm bun notes/t80-credentials-probe.ts` | Real bundled centrs: sequential stale password write succeeds without conflict; duplicate target with two users becomes ambiguous |
| `TMPDIR=/dev/shm bun notes/t80-close-probe.ts` | Synthetic EOF-resistant MSP child: close remains pending after stdin EOF; test kills only its own child afterward |
| `TMPDIR=/dev/shm bun notes/t80-surface-probe.ts` | Real browser: HTML file opens as literal source; an unchanged multi-device TOML save changes inventory count from 2 to 0 while retaining syntactically valid TOML |

Raw gate output is in `t80-gate.log`; sanitized probe results are in
`t80-credentials-result.log`, `t80-lifecycle-result.log` and
`t80-surface-result.log`. Synthetic temporary CDBs/workspaces are removed by the
probe scripts. No real-router commands or writes were needed. No product fixes,
promotion, publication or upstream mutations were performed.

The smoke suite covers workspace/no-workspace, encrypted unlock, wrong password,
bypass, missing CDB, picker creation/open/prune, credentials, chat, cards, output,
twins and alerts. The additional real-browser tour exercises the ordinary file
open/save paths and the right-panel/picker surfaces. Screenshots were inspected
from `proto/routeros-muse/out/ui-smoke/` and `out/t80-review/`.

Historical fail-first runs, original intermediate test counts and the claim of
byte-identical routes before the split were not reconstructed. Current code and
the fresh gate were checked. Meta-provider approvals, actual agent-shell CDB use,
Mac bootstrap paths and the complete twin demonstration remain unproved by this
audit; their acceptance ownership is explicit in T86/T87.

## Material findings and their records

1. **T84 — TOML save changes meaning.** `readTomlSections` flattens an array
   of tables to a JSON string in a synthetic `(top)` section. `wireToml` skips
   the `(top)` header and emits a headerless top-level `slot = "<json>"`
   string (corrected on verification; no `[(top)]` header is written). Syntax
   validation accepts it, but `readSlots` no longer finds either device. This is semantic corruption even
   when the operator edits nothing. The supported shape must round-trip or the
   editor must refuse to save it. Evidence: `out/t80-review/toml-save.png`.

2. **T83 — the artifact APIs are ahead of the viewer.** `renderDoc` assigns
   the file to `textContent`; the real HTML opener shows markup with zero
   rendered headings and zero frames. Picker population also skips generic
   HTML/SVG/PNG files. There is no implemented D19 iframe tier. The generated
   topology page additionally imports Mermaid from a CDN, conflicting with the
   offline/no-external-reference contract. A working artifact HTTP endpoint is
   insufficient to satisfy D17. Evidence: `out/t80-review/artifact-source.png`.

3. **T82/C15 — a stale password baseline is invisible.** `credentialSnapshot`
   contains `hasPassword`, not a secret-safe revision. Password A to B keeps the
   projection identical. A later submit using the older baseline writes C over
   B successfully. This is a sequential stale-edit failure as well as the
   already-recorded concurrent transaction race. The upstream contract needs
   both an expected revision and an atomic check/write boundary; do not create
   a competing CDB persistence mechanism in the harness.

4. **T81 — main-session cache outlives its worker owner.** `ensureMain(key)`
   returns an existing promise before checking ownership. The next
   `ensureMsp(key)` stops that owner and starts a new host, which receives the
   old session ID and returns `sessionNotLoaded`. The next request starts a
   fresh session and succeeds. This is a single operator's lifecycle issue,
   independent of multi-user authorization.

5. **T71 — the proposed Force stop mechanism is graceful EOF.**
   `stopWorker` calls `MspClient.close`, which ends stdin and waits indefinitely
   for `proc.exited`. The controlled child demonstrates that EOF does not
   enforce exit. Force stop requires bounded termination and generation/run
   pinning. A real running tool/descendant exit claim still needs live proof.

6. **T68 — identity must survive the entire device flow.** Inventory preserves
   a user label but keys rows/tabs/routes only by target. Real centrs accepts two
   users for one target, then target-only show fails `identity/ambiguous`;
   password presence is unknown. Verification split the remedy: the show side is
   product-fixable now via `devices show --match user=` (verified ok), while
   retrieve-side disambiguation is an upstream gap (C17/#583) — `--user` is a
   login override, `--where` fails, retrieve rejects `--match` despite its own
   remediation text advising it. No wrong-record mutation was demonstrated.

7. **T72 — conflict re-base discards two pending edits.** The conflict handler
   replaces typed user and SSH-key fields with current server values, despite
   its comment promising to preserve input. Password/profile/session remain.

8. **T89 — the smoke exception filter is broader than its deliberate errors.**
   It ignores any console error containing 400 or 401, rather than identifying
   only the deliberate wrong-password and fake-output-ref requests. The gate
   remains valuable; strengthen it around observed failures rather than
   removing it or equating assertion counts with end-to-end acceptance.

Previously filed T50 (approvals/questions), T49/T55 (targeting and agent
orientation), T56 (failed-send restore), T52 (demo controls) and T66 (lock
affordance) remain real gaps. T64's agent-side acceptance uses an MSP stub that
records environment variables; it does not execute the agent's centrs command.
T86 makes the remaining proof explicit. D20's new/reset-session action now has
T85; T33's unfinished map/chart services now have T88.

## Upstream and tracker reconciliation

Read-only GitHub checks confirmed centrs #551, #558, #581 and #582 remain open.
Both #541 and #547 are merged. The installed package bundle is centrs
0.1.9-next.24, quickchr 0.5.4 and rosetta 0.12.0. Therefore T23's prerelease/old-PR
blocker is stale. C6's merged fix already has the recorded both-transport live
proof and is present in the installed package; its tracker status is now landed.
#547 belongs to the C2 directed-broadcast MAC issue, not C7 auto-protocol failover.
C2 still needs the consumer's hardware/L2 proof reconciled in T23.

T24 and T26 still carry older active ownership. They were not silently reclaimed
or marked complete. `make plan` reports dependency readiness, including active
items, in tracker order; it is not a priority or ownership scheduler. T80's
`recommended_order` and `parallel_followup` fields express this review's sequence.
T61 now waits for T49, and T77 waits for the explicit D33 developer call and T57.

A fresh small-file write in `/tmp` succeeded. The prior quota-full observation
should not be treated as a current failure on that evidence alone. Foreign
processes and other sessions' files were left alone.

## Decision advice and milestone scope

Recommendations, advantages and costs are stored on open D25, D27, D32 and new
D33 (the formerly task-local T77 call). No developer ruling was inferred.

The intended next acceptance is the D16 workflow: handoff document, correctly
oriented real agent, explicit device targeting, approval/question handling,
disposable-twin work and readback, visual evidence in the app, then stop/lock.
Repair semantic data loss and lifecycle failures before that demonstration;
advance upstream encrypted-init/revision work alongside it. Keep Mac-first
Mode A validation and local promotion on their own authorized track. D10/D11
do not make Mode B polish a prerequisite for T14, and this review grants no
promotion or GitHub-publication authorization.
