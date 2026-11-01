# T32 → build handoff: Mode B UI contract (2026-11-01)

Settled structure of Concept B at v10 (`proto/t32-concepts/b-device-console.html`).
Round history lives in `notes/t32-concepts.md`; this file is the build
contract for the ACP hello-world spike, T31 (server), and T33 (render
services). All demo content is fictional (demo-office/gw/ap/cabin-link);
no lab data. Live-data seams are marked LIVE.

## Frame

Three columns. Middle is the shared stage: left and right render into it.

- Left (344px): brand icons (tik ⊕ meta + `full` mode pill), Devices,
  Workspace-recents.
- Middle (flex): tab strip, alert slot, content panes, tail bar,
  target pills, composer, status bar.
- Right (330px, starts collapsed): icon rail (Alerts / Past / Twins /
  Settings) unfolds to the panel; bottom bar swaps views.

Dark/light/auto via CSS var swap; code blocks stay dark.

## Left

- Devices, live via centrs: basic stats only (uptime/cpu/mem, clients,
  signal), selection-only cards. Click opens a device-stats tab (LIVE:
  centrs-tested card data). `in this chat` carries × (removes target +
  pill); `preview in chat ↓` marks the queued preview. Header has
  Add Device (CDB add flow: NOT designed).
- Workspace · recent: recency-ordered rows (logical name + tiny
  filename + kind chip TOML/MD/DIR + right meta), 4 visible, Show more
  expands over the devices section (Show less / select-to-collapse).
  Empty state: Open file button. Header has Add File → picker modal.
  Opening anything tops the recency list. Left rows all open tabs.

## Middle

- Tab strip: `RouterOS Muse` pinned (status slot left of text:
  running dot / down-arrow on unseen / empty same-width; `Unread` pill
  + dimmed tab when away with unseen content; scroll position
  restored on return) + one preview slot (pin-left/close-right;
  replace-by-default, pin-to-keep, close returns to chat). No `+`,
  no fixed Past tab.
- Alert slot: fixed between tabs and chat; serious items with an
  action (Open alerts) + Dismiss; future similar notices live here.
- Chat: compaction divider, injected device cards (reachability,
  interfaces+traffic, errors, fw conns, workspace-fills-CDB-blanks
  row, tested-before-agent footer; failures render in place), amber
  preview card (Add to chat / Not now; prompting without Add sends
  data flagged unclear-intent), agent runcards (explain verdict +
  write-confirmation gate, Run-on-twin-first). Auto-tails; scroll-up
  shows the full-width `Jump to latest` bar resuming the tail.
- Target pills + `+ Device` + `+ File` (no "Talking about" label).
- Composer: 2.5-line autoresizing textarea (spare line past 2, caps
  ~7), Stop-while-running with no elapsed beside it.
- Status bar: Model / Effort / Access selectors, then running-dot +
  counting time (running only), context circle rightmost and bare.
  Clicking time or circle opens the session-stats popover (model,
  access, context %, compactions, devices).

## Right (starts collapsed)

- Alerts: combined needs-attention list (muse doctor + quickchr
  doctor + drift; both doctors run at startup). Bottom tab + rail
  icon turn amber with a dot on news.
- Past: locked, agent-titled, aged rows → open as keyed tabs
  (pin/close, Make current promotes; old main becomes past).
- Twins: per-twin config lines, quickchr totals, `Run quickchr
  doctor` → counts + `Go to Alerts` link.
- Settings: Agent block (muse version, OAuth state, model rows with
  pending-change chip, Reconnect), Appearance seg, Topologies list
  (in-use + Switch + New; new ones start from a template — same
  list the Mode A bootstrap uses), machine paths (workspace dir,
  XDG-ish app state, CDB), write-gate + auto-compact toggles.

## Picker modal (+ File, Add File, empty-state Open)

Tabs: Topology (shared-dir tree), Agentic (2–3 line bubbles for
workspace.toml / router.toml / drift.md / operations handoffs, each
with Open), Upload (file input + Attach to chat). Open puts the file
in the preview slot and tops workspace recency.

## Flows (all verified live in the mock)

Replace-by-default tabs · pin-then-new-slot · past open/resume ·
device stats tab + Add visibility · tree + agentic open with recency
reorder · show more/less + collapse · unread mark/restore · tail
show/resume · banner→Alerts jump · doctor→Alerts link · target ×
removal · stats popover toggle.

## LIVE seams for T31/T33 (mock → real)

- centrs: device list/stats, tested injection cards, explain→run
  with `--yes` gate, transfer/terminal/discover, CDB registry.
- quickchr: twins list/status/console, doctor counts.
- ACP: chat transport, attachments, directory-scope tree, past-chat
  store + compaction, unread/seen state.
- Render services: TOML visual editors (validate-before-save),
  topology (mermaid on web per D21, graphviz/DOT on CLI, text fallback),
  drift/digest views.
- muse: version/access state, OAuth reconnect, model/effort/access
  values, session stats, template/topology list + app-state paths.

## Open debts (not designed)

Attach fallback if ACP attachments prove hard (button is one
removable element) · `workspace.toml` likely needs a `title`
display-name field · XDG app-state → template → PartA launch path is
a bootstrap design issue · setup TOML opens in the generic doc pane
in the mock (wants the visual TOML render) · brand icons → T35
(MikroTik SVG from the tikoci vscode project).

## Settled at approval (2026-11-01)

- Add Device is agent-driven, not a CDB form: the button injects an
  add-device prompt when the agent is idle, and the agent tracks the
  device via the shared topology files per the skills (specialized
  needs live there, not in the CDB alone).
- The agent manages display state via the files in the topology —
  the workspace/tree/buttons reflect topology files the agent owns.
