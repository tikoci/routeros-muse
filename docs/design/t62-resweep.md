# T62 chat UI re-sweep vs t3code (2026-11-01)

Second sweep; first sweep is notes/t41-chat-inventory.md. Research-only:
nothing built, all claims grounded in opened bodies on both sides.
t3code head reviewed: `1d626d02d95f9a2343553f6498037ee82290d304`
(15 commits after `6328c847`, all 2026-11-01). Proto refs are current
`ui.html`/`server.ts` lines post-T40-split. Scope per D29:
MSP-interaction niceties build; platform surfaces defer.

## Head movement: no prior finding overturned

Only 3 of 15 commits touch chat surfaces; all first-sweep t3code refs
re-confirmed unchanged at head:

- `70f475f511` child approvals in parent threads
  (`ChildThreadApprovals.tsx`, `threadRequests.ts:createChildThreadApprovalsAtom`,
  1-line `ChatView.tsx` mount) reuses the same inline approval pattern —
  ignorable for single-session except per-entry error copy.
- `da216062c9` adds `finalFocus` keyboard-only to the Sidebar filter
  combobox — model picker untouched, no effect on the focus verdict.
- `b50d8a1b15` is one CSS spacing line. The other 12 are
  server/desktop/mobile/scripts/docs.

## Ranked proposals (filed T69-T79)

P1. In-flight send guard (breaks trust) → T69. t3code: per-route
`draftSendState` lock shared with resume (`chatViewSend.ts:54-68`),
`sendInFlight` always released (`useComposerSend.ts:1500-1507`).
Proto: `send()` (`ui.html:1534-1558`) has no guard — double-click
double-POSTs `turnStart` (server starts a turn per POST: double turn,
double spend). Scope: disable Send from dispatch to ack/failure;
share the lock with resume later.

P2. Mid-run send intent honesty (polish) → T70. t3code:
`resolveComposerDispatchMode` (`composerDispatch.ts:4-16`, default
steer, modifier flips), morphing icon/label
(`ComposerPrimaryActions.tsx:115-122,280-284,333-334`), "Click to X,
⌘-click to Y" tooltip (`:299-301`), visible approvals force steer
(`ChatComposer.tsx:1170-1174`). Proto: every send is an undifferentiated
POST; placeholder "Reply or steer while it runs…" (`ui.html:720`) names
steering without saying what mid-run send does. Scope: label mid-run
Send as Steer + tooltip naming MSP behavior; probe mid-run `turnStart`
semantics first. (First sweep lumped this into GAP12-defer; this sweep
splits it: queue *surface* defers, steer *intent* builds.)

P3. Stop lifecycle: Stopping state + run-pinned Force stop (breaks
trust) → T71. t3code: Stopping ticker, run-pinned Force stop
(`ThreadActivityBanners.tsx:114-152`, unchanged at head). Proto: stop is
`fetch` then unconditional `setRunning(false)` (`ui.html:2177-2181`) —
claims stopped even if the POST fails; server route returns
`stopped:false` cases the UI ignores. Scope: Stopping ticker until
`turn/completed`/timeout, then Force stop (T64 `stopWorker` is the
mechanism).

P4. Credentials modal hardening, t3code secret-input patterns (breaks
trust, mild) → T72 (blocked T48, done). t3code: `type="text"` +
`[-webkit-text-security:disc]` + password-manager opt-outs
(`SecretRequestCard.tsx:125-136`); native-form Enter submit + sync
double-submit guard (`:71,94-104`); busy-blocks-close
(`LinkRequestCard.tsx:324-329`); clear-on-success/retain-on-failure
(`SecretRequestCard.tsx:85-87`); failure whitelist so typed secrets
never echo (`secretRequest.ts:77-97`, `linkRequest.ts:288-314`); ssh-key
guidance (`LinkRequestCard.tsx:415-418`). Proto: `type=password`
(`ui.html:690`) invites save-prompts; Save click-only, no in-flight
guard (`saveCred :1091-1120`); Esc/backdrop close during save;
success-clear unspecified; `j.why` shown raw (`:1116`). Scope: all six
fixes + audit that typed values never echo.

P5. System-error banner (polish) → T73. t3code: nested-message banner,
per-thread dismiss (`ThreadErrorBanner.tsx`). Proto: send/stream
failures render as agent voice (`ui.html:1551,1555`) — honest but
misvoiced; T39's oauth-required 403 path (`:1550`) too. Scope:
dismissible banner for system errors; coordinate with T56's
send-failure UI.

P6. Local-only find bar, GAP5 (polish) → T74. t3code: single-thread
store (`threadFindStore.ts:24`), mod+f + refocus-restart (`:84-105`),
server search w/ local stepping (`useThreadFind.ts:95-151,279-294`),
CSS-Highlight painting + folded-match reveal
(`threadFindHighlights.ts:17,93,228-229`), viewport-anchored refind +
live refresh (`useThreadFindNavigation.ts:35`,
`useThreadFind.ts:155-198`), wrap-around, count label, find releases
follow (`threadFindStore.ts:80-82`). Proto: absent. Scope: mod+f bar,
DOM search + highlight + Enter-nav + count only — explicitly no server
search (bounded single transcript).

P7. Focus open/close/return contract, picker/modal/menus (polish) →
T75. t3code: `initialFocus=search` + default return-to-trigger
(`ProviderModelPicker.tsx:416`); Esc/outside-close
(`ComposerStashMenu.tsx:48-57,72`). Proto: `openPicker/closePicker`
(`ui.html:1031-1039`), `openCred/closeCred` (`:1061-1068`),
`openMenu/closeMenu` (`:2021-2050`) move no focus and strand it on close
(lock screen excepted — FINE). Scope: focus-in on open,
return-to-trigger on close, Esc everywhere missing.

P8. Screen-reader run-state announcements (polish) → T76. t3code:
Working/Approval/Input/Done/Failed/Stopped live regions
(`threadActivityAnnouncement.ts:99-175`). Proto: `aria-label` only.
Scope: one live region updated in `setRunning`/`onStream`.

P9. Prompt stash, park/restore draft (polish, defer-leaning — dev call)
→ T77 (blocked, external: developer decides build-or-drop; needs T57
storage shape if built). t3code: 20 entries
(`promptStashStore.ts:15`), durable-write-then-clear + quota-rollback
(`useComposerStash.ts:524-552`, `promptStashStore.ts:149-159`),
localStorage v2 + memory fallback (`:11,81-96`), keyboard menu
(`ComposerStashMenu.tsx:72-124`), pulse badge
(`ComposerStashBadge.tsx:18-28`), append-never-overwrite restore +
aggregate warnings (`useComposerStash.ts:158-417`), mod+s capture
(`:674-709`). Proto: absent.

P10. Selector menus: keyboard nav + disabled reasons (polish) → T78.
t3code: arrow/Enter/Esc/jump-key map + IME guard
(`ModelPickerContent.tsx:780-992`), disabled rows keep tooltips
(`ModelListRow.tsx:49,149`), disabled-instance explanations
(`ModelPickerSidebar.tsx:136-159`). Proto: `selmenu` mouse-only, flat
catalog, no disabled state (`ui.html:2023-2050`, `modelCatalog` `:2019`).
Scope: keyboard nav for all three selectors; disabled reasons need a
server catalog marking.

P11. Context Compact action (polish) → T79 (blocked T55). t3code:
`/compact` turn in send pipeline (`useComposerSend.ts:1253-1434`),
meter popover Compact action (`ContextWindowMeter.tsx`). Proto: ring +
popover, no Compact (`ui.html:2139-2170`). Scope: Compact affordance
once the MSP surface is confirmed.

## Existing-task design inputs (appended to task evidence, details here)

T50 (approval/question surface): approval kinds/detail/waiting
labels/not-live copy/full-access explanation
(`TimelinePendingApprovalRow.tsx:15-122`); options incl
`acceptForSession` + warnings
(`ComposerPendingApprovalActions.tsx:26-141`); question
auto-advance/digits/collapsible/dismiss + custom-answer-in-composer
(`ComposerPendingUserInputPanel.tsx:30-334`;
`useComposerSend.ts:491-492,536-543`); in-flight dedupe/attachment
gating/typed-text-rescue toast (`usePendingThreadRequests.ts:299-458`);
decline-before-send + `approvalRedirectNotice` copy
(`useComposerSend.ts:1029-1148`; `composerSend.logic.ts:63-81`);
`sendApprovalFeedback` (`threadRequests.ts:28-36`); secret
masking/clear/sanitize; inline-over-modal; needs a minimal toast
primitive. CORRECTION: `composerSend.logic.ts` is copy-only (81 lines) —
the hold is typing-guard `heldRequestIds` + decline-before-send. And
"onStream drops" is now precisely the UI layer (`ui.html onStream
:1560-1643` has no approval/question branch; `transcriptItems` generic
fallback `server.ts:301-319` renders them inert) — the server forwards
all methods (`server.ts:564-604`), so T50 needs no transport work.

T56 (failed-send restore): restore ONLY if draft still empty;
interrupted sends get no error toast (`useComposerSend.ts:1436-1498`);
`restoreComposerDraft` (`chatViewSend.ts:259-274`); plan-failure full
restore (`:719-793`); uploads must not strand on resend (`:945-981`).

T60 (resume): shared `sendInFlight` lock (`useComposerResume.ts:88-99`);
model read before first await (`:109-111`);
`manualContinuationOfRunId` + fixed continuation +
`dispatchMode:"start"` (`:123-139`); `scrollToEnd` (`:153-155`).

T41 (renderer): 15-kind row union + `TimelineRowContent` dispatch
(`MessagesTimeline.tsx:496-635,1436-1519`); `WorkGroupSection` grouping;
stable-row identity (`useIncrementalTimelineRows`/`useStableRows`);
per-type expanded bodies (`V2ItemInspector.tsx:232-405`); per-turn
`ChangedFilesCard` (`ChangedFilesTree.tsx:28`); empty/loading states
(`MessagesTimeline.tsx:719-725,1281-1301`). CORRECTION:
last-ready-while-loading mechanism NOT verified (route-vs-active key lag
unopened) — do not build on the first-sweep claim.

## GAP12-13 D29 judgments

Build: steer-intent (P2), secret-request patterns (P4 + T50 inputs).
Propose (dev call): stash (P9). Defer: queue rows/edit/expander,
fanout, side-chat, subagent-bar, branch-banner, goal (multi-thread
platform); notifications modes/badge/sounds (explicit D29); minimap
(timeline chrome); link/pairing wizard (no peer links);
terminal-chip/mention-drag/context-undo/import (no chip system; T61
covers the need); usage/limit banners (explicit D29 — T39's oauthbanner
already covers auth-guidance); McpApp/HtmlRender frames, DiffPanel,
ThreadDetails shell, automations, relationships, PR rows, worktree setup
(no setup phase in proto).

## 7 coverage-gap areas — resolved

ChatComposer submit/dispatch; MessagesTimeline (row union/dispatch/
grouping inventoried; last-ready unverified, see correction);
useComposerSend (fully read, 1511 lines); app/tool surfaces,
ThreadDetails/PR/automations, worktree setup, picker internals (all
inventoried; BUILD/DEFER split per D29 above).

## T39/T40/T64 effects on prior findings

T39 narrowed menu-focus: lock screen now focuses password — lock FINE,
P7 covers picker/menus/modal only. Second banner added (oauthbanner) —
provider-auth slice now partial; banner-stack verdict stands (fine at
2). Passive `authRequired` flip is new error-honesty evidence. T40
registry picker is a right-panel view, not overlay — overlay verdict
stands. T64 `stopWorker` + workerEnv gives P3 its Force-stop mechanism.

## Checked and FINE (no re-sweep needed)

Model-switch pending chip + clear; lock focus; credmodal 409 re-base;
optimistic user render staying put; tab-switch scroll restore + DOM
unread badge; attachment intake honesty; mode-aware placeholders; 8-tier
effort menu; tail-or-unread + tailbar; subagent card; honest
output-fetch error; server forwards all MSP methods; submit guards re
compression/chips N/A; snapshot/race patterns N/A; all 15 head commits
triaged.

## Not covered (why)

`useComposerTypingGuard.ts` hold mechanics, `ChatView.logic`
plan/snapshot bodies, `MessagesTimeline.logic` derivation,
`Timeline*Row` bodies, `ModelPickerList` virtualization, `DiffPanel`
header controls, `ThreadRelationships` render tail, ChatComposer render
regions (~2/3 of file) — none needed for a D29-scoped proposal.
Mobile/desktop/server hunks out of web-chat scope. No live-browser runs
(read-only brief). t3code clone kept at /dev/shm/t62-t3code during the
sweep (ephemeral; re-clone for verification).
