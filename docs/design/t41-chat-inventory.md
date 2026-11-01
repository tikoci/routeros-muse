# t3code chat-window behavior inventory + proto comparison (2026-11-01)

Feeds T41 (renderer port) and T50 (approval/question surface).
Source: `https://github.com/pingdotgg/t3code` at `6328c847` (same basis as
T42; clone at `/tmp/t42-ux`). t3code paths below are under `apps/web/src/`
unless noted. Proto refs are `proto/routeros-muse` `ui.html` / `server.ts`.

T42 (`notes/t42-t3-ux.md`) covered rendering/schemes. This pass covers
chat-window BEHAVIOR only, every item backed by an opened implementation
body. Method: explore subagent (144 tool calls) inventoried t3code, compare
subagent checked each item against the proto bodies. No code changed.

## Verdict counts

- match: 0 — nothing matches fully.
- partial: 19 — skeleton exists, subtleties missing.
- missing: 82 — mostly out-of-scope platform surfaces, plus ~10 real gaps.

## Full verdicts (`t3 behavior (t3 ref) | verdict | proto ref | note`)

COMPOSER INPUT
- send-shortcuts: Enter sends, mod-enter variants, no software-kb send
  (composer-logic.ts:59-93) | partial | ui.html:1851-1853 | Enter sends,
  Shift+Enter newline; no variants, kb guard, or background intent
- composer-key-routing: Tab/Shift+Tab/Esc/arrows/list-continuation
  (composerCommandKey.ts:199-264) | missing | absent | no menu/history
  to route keys to
- prompt-history: Up/Down recalls own typed prompts, attribution-filtered
  (composerCommandKey.ts:139-178) | missing | absent | arrows unbound
- history-sanitization: recall strips prefixes/context blocks/chips
  (composerPromptHistory.ts:73-138) | missing | absent | no recall
- mention-triggers: / # currency @ trigger menus (composer-logic.ts:251-293)
  | missing | absent | plain textarea, no triggers
- menu-highlight: auto-active first, sticky highlight
  (composerMenuHighlight.ts) | missing | absent | selmenu is mouse-only
- menu-dismiss: sticky Esc dismissal per trigger+position
  (useComposerTriggerState.ts:9-38) | missing | absent | —
- slash-filtering: start-only commands, skill: prefix
  (composerSlashCommandSearch.ts:15-41) | missing | absent | no slash menu
- prompt-segments: text/mention/skill/citation segments
  (composer-editor-mentions.ts:78-142) | missing | absent | plain text
- multiline-detect: range-rect wrap measure drives action collapse
  (useComposerMultilinePrompt.ts:4-53) | partial | ui.html:984-991 |
  fitInput autogrows; no wrap measure or collapse
- typing-guard: arriving requests held 1.5s past keystroke
  (composerTypingGuard.ts) | missing | absent | rows render mid-type
- length-limit: send blocked over max chars with over-count
  (composerSubmission.ts:12-31) | missing | absent | empty-check only

SEND / STOP LIFECYCLE
- primary-actions: morphing Stop/question/plan/Resume/queue/compact
  (ComposerPrimaryActions.tsx:127-391) | partial | ui.html:612-623 |
  Send/Stop swap only
- queue-vs-steer: followUpBehavior default + modifier-click alternate
  (ComposerPrimaryActions.tsx:115-123) | partial | ui.html:619 | mid-run
  send allowed; no behavior setting or alternate
- send-busy: busy from dispatch to server ack (useLocalDispatchState.ts:11-66)
  | partial | ui.html:612-623,1341 | gated send-to-completed; no ack scope
- optimistic: instant user message, ack removes, blob handoff
  (optimisticUserMessages.ts:24-70) | partial | ui.html:1338 | renders
  pre-POST; no ack removal
- stop-lifecycle: Stopping ticker, run-pinned Force stop
  (ThreadActivityBanners.tsx:114-152) | partial | ui.html:978-983,1854-1858 |
  elapsed ticker; stop is fire-and-forget
- failed-send-restore: prompt/media restored into draft (chatViewSend.ts:259-274)
  | missing | ui.html:1350-1357 | failure appends error text; draft lost
- sr-announce: Working/Approval/Input/Done/Failed/Stopped live regions
  (threadActivityAnnouncement.ts:99-175) | missing | absent | aria-label only
- visit-mark: outside-React read watermark (ThreadVisitWatermark.tsx:16-22)
  | partial | ui.html:627-647 | DOM unread badge; no watermark

DRAFTS / STASH
- draft-persist: localStorage drafts incl images (composerDraftStore.ts:112-134)
  | missing | absent | reload loses the prompt
- stash: 20 entries, durable-write-then-clear (promptStashStore.ts:15-17)
  | missing | absent | —
- stash-menu / stash-badge: keyboard menu, pulse badge
  (ComposerStashMenu.tsx:59-124, ComposerStashBadge.tsx:7-62)
  | missing | absent | —

ATTACHMENTS & CONTEXT
- attachment-intake: slot caps, typed errors, compression
  (useComposerAttachmentIntake.ts:115-329) | partial | ui.html:1866-1892 |
  image + <=64KB text via modal; no caps/progress/typed errors
- attachment-classify: SVG/DNG/HEIC/MIME rules
  (composerAttachmentFiles.ts:84-101) | partial | ui.html:1873-1888 |
  image-vs-text split only
- paste-fold: oversized pastes become pasted-text-N.txt + toast
  (useComposerAttachmentIntake.ts:359-434) | missing | absent | pastes inline
- remove-referenced-image: destructive confirm
  (useComposerAttachmentIntake.ts:331-357) | missing | absent | —
- attachment-strip: per-tile progress/retry/remove
  (ComposerAttachmentStrip.tsx:150-328) | missing | absent | placeholder
  text only
- question-attachments / context-import / mention-drag / context-undo /
  terminal-chip: question drafts, chip import, drag mentions, undo
  payloads, terminal chips | missing | absent | no chip/mention system

FOCUS & KEYBOARD
- type-to-focus / paste-to-focus: keys and stray pastes route to composer
  (composerFocusRedirect.ts:62-80, usePasteToFocusComposer.ts:21-56)
  | missing | absent | —
- window-shortcuts / shortcut-commands: chords + command registry
  (useChatShortcuts.ts:53-140, contracts/keybindings.ts:37-116)
  | missing | absent | only Enter/Esc bound
- page-scroll: eased accelerating PageUp/Down (pageScrollController.ts:28-70)
  | missing | absent | native scroll
- menu-focus / dialog-focus: focus return on close (composerEventScope.ts:12-93,
  ExpandedImageDialog.tsx:89-99) | missing | absent | picker/menu closes
  strand focus

TIMELINE / SCROLL
- follow-machine: following/released + end-band hysteresis
  (timelineViewport.ts:183-245) | partial | ui.html:1215-1219,1328-1333 |
  tail-or-unread on append; no hysteresis or unified release
- viewport-listeners: unified scroll-release inputs (timelineViewport.ts:70-175)
  | missing | absent | one chat-scroll listener
- new-turn-anchor: user message anchored near top (useTimelineFollow.ts:271-298)
  | missing | absent | appends at end
- scroll-pill: pill names waiting content, debounced
  (TimelineOverlays.tsx:26-55) | partial | ui.html:214-215,970-976 |
  generic Jump-to-latest; names nothing
- position-restore: per-thread row+offset memory (useTimelinePositionRestore.ts)
  | partial | ui.html:631-647 | offset kept across tab switch; one chat
- thread-switch: last-ready timeline while loading (ThreadTimeline.tsx:38-57)
  | missing | absent | past chats load read-only behind placeholders
- system-divider / lifecycle-rows: interrupt/fork/handoff/subagent dividers
  (TimelineSystemDivider.tsx:7-66, V2LifecycleRow.tsx:66-178)
  | missing | absent | unknown kinds render generic cards
- lifecycle-rows (subagent half): subagent link + status dots
  | partial | ui.html:1172-1194 | subagent card; no dividers or dots
- user-rows: fold/collapse/revert-pencil/steer badges
  (TimelineUserMessageRow.tsx:408-441) | missing | absent | —
- work-groups: expandable persisted groups (TimelineWorkGroupRows.tsx:73-125)
  | missing | absent | flat card list
- assistant-actions / copy-toast: fork-from-response + streaming-aware copy
  with anchored toast (TimelineAssistantRows.tsx:85-224,
  MessageCopyButton.tsx:32-34) | missing | absent | no copy at all
- minimap: per-turn plain-text items (timelineMinimapItems.ts:17-112)
  | missing | absent | —
- thread-now: end-of-timeline attention/background/sync/goal lines
  (ThreadNow.tsx:79-103) | missing | absent | runstat + alert banner
  are separate, not a family
- cite-select: Cite pill on assistant-text selection
  (AssistantSelectionToolbar.tsx:51-216) | missing | absent | —

APPROVALS / QUESTIONS (direct input to T50)
- approval-row: 5 kinds, Waiting label, inline actions
  (TimelinePendingApprovalRow.tsx:15-122) | missing | absent | approvals
  would render as inert generic cards
- approval-actions: Approve/Decline + More + warnings
  (ComposerPendingApprovalActions.tsx:26-141) | missing | absent | access
  selector sets mode but offers no per-approval action
- send-over-approval: sends held with reason (composerSend.logic.ts:62-81)
  | missing | absent | mid-run sends always dispatch
- question-panel: auto-advance, digit shortcuts, collapsible, dismiss
  (ComposerPendingUserInputPanel.tsx:130-177) | missing | absent | no UI
- question-flow: in-flight dedupe, attachment gating, typed-text rescue
  (usePendingThreadRequests.ts:299-458) | missing | absent | —
- secret-request / link-request: masked secret input, pairing wizard
  (SecretRequestCard.tsx:53-174, LinkRequestCard.tsx:202-330)
  | missing | absent | —

REVERT / FORK / RESUME / QUEUE
- revert / revert-confirm / rewind-send: guarded edit-from-here with
  files-too-vs-keep dialog (useTimelineRewind.ts, ChatOverlayHosts.tsx,
  chatViewSend.ts) | missing | absent | —
- fork: "X fork" + navigate (useTimelineRewind.ts:174-213)
  | missing | absent | —
- resume: fixed continuation under send lock (useComposerResume.ts:87-166)
  | missing | ui.html:455 | Make-current button exists but has no handler
- queue / queue-edit: 3+expander rows, edit-in-composer
  (QueuedRunsControl.tsx:166-231, useQueuedRunEdit.ts:180-239)
  | missing | absent | —
- fanout: one worktree thread per model (chatViewSend.ts:76-149)
  | missing | absent | single session only

MODEL / MODES / USAGE
- model-switch: cross-provider handoff guard + sticky options + focus
  return (useComposerSelection.ts:142-216) | partial | ui.html:1729-1735 |
  pending chip only
- modes: Supervised/Auto/Auto-accept/Full-access + fallback + plan toggle
  (runtimeModeConfig.ts:4-48) | partial | ui.html:1689-1694 | 4 access
  modes selectable; no fallback/plan/target rule
- effort: per-model options, Ultrathink tint, caret-preserving stepping
  (composerProviderState.tsx:96-197) | partial | ui.html:1688,1788-1798 |
  8-tier menu; no tint or caret work
- model-search: scored fuzzy search + favorites (modelPickerSearch.ts:55-126)
  | missing | absent | flat catalog menu
- context-meter: ring + popover with Compact action (ContextWindowMeter.tsx)
  | partial | ui.html:421-432,1816-1846 | ring + popover; no Compact,
  cost, or disabled reasons
- usage-banner / usage-intercept / limit-recovery / provider-status:
  per-account banners, recovery, provider setup (ComposerUsageLimits.tsx,
  UsageLimitRecoveryBanner.tsx, ProviderStatusBanner.tsx)
  | missing | absent | —
- subagent-bar: delegated-session bar (ProviderSubagentBar.tsx:13-77)
  | missing | absent | single session only

ERRORS / OFFLINE / EMPTY
- thread-error: nested-message banner, per-thread dismiss
  (ThreadErrorBanner.tsx:29-128) | missing | absent | errors append as
  agent text
- offline: grace + reconnect/disconnect/update banners
  (useSystemComposerBanners.tsx:156-264) | partial | ui.html:387,1959-1960 |
  SSE reconnect chip; no grace or manual control
- banner-stack: ordered stack + overflow popover (ComposerBannerStack.tsx)
  | missing | absent | single alert banner
- branch-banner / goal: drift Restore, goal Resume/Clear
  (ThreadActivityBanners.tsx) | missing | absent | —

FIND / NOTIFICATIONS / MISC
- find bundle: store + bar + server search + CSS-Highlight painting +
  navigation + viewport refind (threadFind*.ts, ThreadFindBar.tsx,
  useThreadFind*.ts) | missing | absent | no find at all
- notifications: modes, favicon badge, sounds (threadNotifications.ts:7-121)
  | missing | absent | —
- side-chat / side-pane: forked embedded chat (useSideChat.ts, SideChatPane.tsx)
  | missing | absent | —
- image-dialog: gallery + zoom + pan (ExpandedImageDialog.tsx:121-160)
  | missing | ui.html:1277-1284 | images inline in output tab only
- plan-mode / slash-side: /plan /default /side /btw (composer-logic.ts:322-337)
  | missing | absent | —
- header: crumb, title menu, double-click rename (ChatHeader.tsx:162-284)
  | partial | ui.html:386-388,786-803 | pinned/working tabs + unread;
  no rename/menu/crumb
- overlay-scope: per-thread dialogs (ChatOverlayHosts.tsx:29-56)
  | missing | absent | picker is global
- t42-rendering: grouping/markdown/code/mermaid/collapsibles/diffs
  | partial | server.ts:147-256;ui-smoke.ts:133-310 | T37 cards + diff
  renderer; markdown/mermaid/collapsibles per T42 remain

## Ranked gaps (comparer disposition)

1. failed-send-restore — user text is destroyed on failed send; restore it
   into the composer. Suggested: new task.
2. approval-row + approval-actions — Access=Ask-first promises approvals
   but pending approvals render as inert generic cards. Suggested: new
   task (or fold into T50, which owns the approval surface after its
   wire-shape repro).
3. question-panel + question-flow — agent questions stall turns with no
   visible UI to answer them. Suggested: new task (same T50 note).
4. draft-persist — reload loses the composed prompt; localStorage draft is
   cheap. Suggested: new task.
5. find bundle — long transcripts are unnavigable without find.
   Suggested: new task.
6. assistant copy + user-rows collapse — reply chrome. Suggested: fits T41.
7. work-groups grouping — flat cards will drown long turns; grouping is
   renderer work. Suggested: fits T41.
8. prompt-history — retyping repeat prompts is daily friction; recall is
   small. Suggested: new task.
9. length-limit — unbounded sends risk provider rejection; cheap guard.
   Suggested: new task.
10. resume (wire Make current) — button already exists unwired in the
    past-chat tab. Suggested: new task.
11. @device-to-target trigger — scoped trigger beats the full mention
    system; target pills already exist. Suggested: new task.
12. queue/steer, fanout, side-chat, subagent-bar, branch-banner, goal —
    out of scope: single-session prototype has no second thread to queue,
    fan out, or dock.
13. notifications, minimap, stash, secret/link, terminal-chip, mention-drag,
    context-undo/import, usage/limit banners — out of scope: platform
    surfaces the prototype does not have; revisit after core gaps land.

## Coverage gaps (inventory unresolved; effect on this report)

The explorer disclosed 7 surfaces it did not inventory. Verdicts touching
them rest on partial inspection; a follow-up can inventory any of them if
we pursue composer-depth work:
- ChatComposer.tsx body (142KB) submit/dispatch internals beyond
  handle/grep level.
- MessagesTimeline.tsx grouping/rendering internals (T42 covered the
  grouping machine; row components covered the behavior rows).
- useComposerSend.ts full send pipeline (59KB); per-branch error mapping
  not exhaustively inventoried.
- V2ItemInspector/FetchedToolOutput, McpAppFrame/HtmlRenderFrame,
  ChangedFilesTree, DiffPanel (app/tool surfaces adjacent to chat).
- ThreadDetails panel/relationships, PR rows, automations panel.
- WorktreeSetupCard, useWorktreeSetup.
- ProviderModelPicker/ModelPickerContent/Sidebar full picker internals
  beyond search/keys/disabled-reasons.
