---
name: harness-capability-inventory
description: "Inventory what each agent harness can surface (HTML? images? links? files? live pages?) so presentation choices key off evidence, not guesses. Use when: picking a presentation format for findings, adding a new harness to the matrix, re-checking a catalog that may have drifted, or asking why the presentation layer renders differently per harness."
topics: [harness, inventory]
tested: none
---

# `harness-capability-inventory` skill (per-harness surface matrix + re-check cadence) [template v1 draft]

Prerequisite for presentation-layer: agents surface
findings as visuals suited to the PARTICULAR harness, and
this skill is the procedure that says what each harness can
actually surface. Claim discipline is load-bearing: a cell
marked **observed** was verified with a command on a named
machine (command + output in the proof note); **collected**
carries a source citation and was not re-verified here;
**pending** is an honest gap — never fill it with a guess.
Matrix v1 below is dated 2026-10-30 (local-workstation observed
row; sandbox-agent row collected; Meta rows pending). No twin, no
box contact anywhere in this procedure. No secrets below.

## Part 1 — The checklist (matrix first, presentation second)

Run top to bottom. presentation-layer keys off the matrix this produces —
a presentation choice without a matrix row behind it is a guess.

1. Fix the harness list + columns: one row per harness, one
   column per surface question (step 0).
2. Fill the observed row for THIS machine with commands
   (render + serve + file probes, step 1).
3. Fill collected rows from dated sources, cited (step 2).
4. Mark everything else pending — no guessing (step 3).
5. Stamp the re-check date; extend per new harness (step 4).

### 0. Fix the harness list + columns (the matrix frame)

Harness rows (v1, from an earlier scoping ruling):

- Local workstation (Muse Code CLI on this box) — observed row.
- Sandboxed agent app — collected row (live catalog, dated).
- T3 Code desktop — collected ruling, details pending.
- Meta desktop options — pending (to-evaluate, unfamiliar).
- Plain chat — pending (no baseline probed yet).

Surface columns (every row answers all six):

| Column | Question it answers |
|---|---|
| HTML | Can the owner SEE rendered HTML (inline or served)? |
| Images | Can it show a PNG/SVG (generated or attached)? |
| Links | Can it follow or deep-link (file, WebFig, map)? |
| Files | Can it read/write files the owner can reach? |
| Live pages | Can it serve a page the owner loads live? |
| Evidence channel | Where do durable artifacts land? |

- A cell holds exactly one of: yes / no / partial +
  its label (observed/collected/pending) + date.
- "No" needs the same evidence as "yes": a failed probe
  with output, or a source that states the absence. An
  unprobed negative is pending, not no.
- Matrix v1 (2026-10-30) lives in step 3; it is a
  snapshot, not doctrine — step 4 keeps it honest.

### 1. Fill the observed row (commands on THIS machine)

Grounded (proof note, local workstation, 2026-10-30).
Only these probes may mark workstation cells observed:

```sh
# render probe: can this box GENERATE images/diagrams?
echo 'digraph { a -> b }' | dot -Tsvg | head -5   # SVG header out
echo 'digraph { a -> b }' | dot -Tpng | wc -c     # 3310 bytes out
# serve probe: can this box SERVE a live page on loopback?
setsid -f bun -e 'Bun.serve({port: 18923, fetch: () => new Response("<h1>probe-ok</h1>", {headers: {"Content-Type": "text/html"}})})' </dev/null >>/tmp/harness-probe.log 2>&1
curl -s -o /dev/null -w 'http=%{http_code} type=%{content_type}\n' http://127.0.0.1:18923/
# -> http=200 type=text/html ; then pkill -f 'port: 1892[3]' (bracket trick)
```

- Observed toolchain (same proof): bun 1.4.4, dot
  (graphviz) 16.1.0, gh 2.103.2, git 2.56.0;
  centrs/quickchr/rosetta symlinked in ~/.local/bin
  (presence only — never invoked here, no box contact).
- Observed platform: /dev/kvm present, 8 CPUs, loopback
  serve works, cleanup confirmed (`cleaned-up`).
- Observed workstation cells: Files yes (read/write on disk);
  Live-pages-on-loopback yes; image GENERATION yes
  (SVG header + 3310-byte PNG). Inline HTML rendering
  and inline image DISPLAY in the owner's UI are NOT
  shell-provable — they stay pending (UI-level probe owed).
- A small Bun.serve review server (default
  loopback port, file-backed, no deps) is the standing
  workstation live-surface pattern — file presence observed,
  serving behavior covered by the probe above.

### 2. Fill collected rows (cited, not re-verified)

Sandbox-agent row — collected from a tool inventory
(live catalog captured 2026-10-24, by the sandbox agent itself):

- Evidence channel: GitHub Issues (approval per write)
  + Drive .md files (cheap, schedulable, no human in
  the loop) are the shared mutable surfaces (§"What to
  code around"). Drive house pattern is create/update
  IN PLACE by file ID; `files delete` is permanent.
- Toolset wall (GitHub): 46 tools on the pinned default
  endpoint; no Projects/Gists/Notifications/Actions/
  low-level-Git reads or writes — route to a macOS environment
  or redesign. `get_issue` already drifted against its
  own connector doc once.
- Reachability limits: no inbound reachability; egress
  via authenticated proxy (credentials rotate); outbound
  UDP blocked at syscall level; sandbox browser cannot
  navigate to loopback addresses.
- Machine snapshot (same doc, same date): Ubuntu 24.04.5,
  2 vCPU, no /dev/kvm (TCG emulation — CHR boots take
  minutes), 7.7 GiB RAM no swap, 100 GB home durable,
  /tmp 512 MB tmpfs ephemeral, apt packages ephemeral.

Agent-app surfacing — collected from the platform tooling explainer
(2026-10-23/24, re-check pricing/tiers at dev.meta.ai):

- Approval cards gate consequential actions; credentials
  are surrogated (model never holds them).
- Images: Muse Image generates/edits pictures ($0.01
  each); topology-correct diagrams come from the
  Spark → Graphviz DOT → SVG pipeline (pixels from a
  generator are unverifiable — never the source of a
  topology claim). Inline DISPLAY in-app unverified here.
- Maps: no Meta maps API; in-app map surfaces ride third
  parties (geocoding, Places Search); OSM/MapLibre for
  geo maps, Graphviz for network maps; Mapillary speculative.
- Connectors: custom (available now, API key or OAuth
  code flow only) vs directory (muse.ai/platform review,
  no published SDK as of Sept 2026).

T3 Code desktop — collected from an earlier scoping ruling (developer
ruling 2026-10-29): desktop leans T3 Code (visuals,
nightly Muse, remote ability); agent-app→T3 from sandbox
is the prize; OAuth friction today; expect the sandbox to
sort it. Every surface cell still pending.

### 3. Mark the rest pending (matrix v1)

Matrix v1, 2026-10-30. Label + date on every cell;
citations in steps 1–2. Pending = unprobed, not absent.

| Harness | HTML | Images | Links | Files | Live pages | Evidence channel |
|---|---|---|---|---|---|---|
| Local workstation | served yes (observed); inline pending | generate yes (observed); inline display pending | file paths yes (observed); deep-link follow pending | yes (observed) | loopback yes (observed); LAN/inbound pending | local files + handoff notes (observed pattern) |
| Sandboxed agent app | pending | generate yes (collected, explainer); display pending | pending | Drive .md in place (collected); repo files via connector (collected) | no loopback/inbound from sandbox (collected); served-via-Drive partial (collected) | Issues + Drive .md (collected) |
| T3 Code desktop | pending | pending (visuals lean, collected ruling) | pending | pending | pending | pending |
| Meta desktop | pending | pending | pending | pending | pending | pending |
| Plain chat | pending | pending | pending | pending | pending | pending |

- The workstation "pending" cells need a UI-level probe (show
  HTML/an image/a link to the owner, record what
  rendered) — shell commands cannot close them.
- Sandbox "pending" cells need a sandbox session
  (list-tools + surface probes); do not fill them from
  the workstation — different sandbox, different browser, different wall.
- Meta rows stay pending until the to-evaluate work
  happens (developer ruling: unfamiliar). Plain-chat
  baseline (text only?) is inferred-minimal at best —
  treat as pending until one real session grounds it.

### 4. Stamp the re-check date; extend for a new harness

- Re-check cadence (catalogs drift — the inventory doc
  says so itself, and `get_issue` already drifted once):
  re-run the observed row monthly or whenever a
  presentation fails to render; re-pull the sandbox
  catalog (`list-tools`) before building on ANY absence;
  re-check explainer pricing/tiers at dev.meta.ai before
  quoting externally; stamp every touched cell with the
  new date. A matrix older than ~30 days is a rumor —
  presentation-layer must say so when it keys off one.
- Extend for a new harness with the same five probes,
  each recorded as command + output in a proof note:
  (1) render HTML to a file and show it; (2) generate
  SVG+PNG via dot and show them; (3) hand the owner a
  link (file path, served page, deep link) and record
  what followed; (4) round-trip a file the owner can
  reach; (5) serve a loopback page and have the owner
  (or curl from the owner's context) fetch it. Observed
  cells get the machine + date; unshowable cells stay
  pending with the probe that was attempted.
- File the proof note next to the others
  (`notes/<harness>-proof.md`), update the matrix
  row + date, and leave a handoff note so the next session
  knows which harness gained ground.

## Part 2 — Skill doc

### Trigger

Load when: picking a presentation format for findings
(presentation-layer renders per this matrix); adding a new harness to
the matrix; re-checking a catalog that may have drifted;
asking why a visual surfaced (or failed to) in a given
harness; any "can the owner SEE this here?" question.

### Prereqs

- The matrix above (v1, 2026-10-30) + its proof note
  for the observed row.
- Re-probe collected or stale matrix cells in the environment
  being inventoried before relying on them.
- Shell on the machine being inventoried (observed row);
  `dot` for the render probe, `bun` + `curl` for the
  serve probe. No twin, no router contact, no credentials.

### Access

- All probes are local reads + local compute: safe on
  any box, including alongside production work.
- The serve probe binds LOOPBACK on an ephemeral port
  and is killed + verified down immediately after —
  never bind it to a LAN interface, never leave it running.
- Sensitivity tiers throughout (pre-publish-scrub): no creds,
  tokens, serials, or IPs in the skill or the proof
  (loopback excepted — it names no host). Captures under `pull/out/` stay local-only;
  cite redacted facts only. Listener scans that print
  site-local addresses stay out of the proof.

### Envs

| Name | Use |
|---|---|
| `HARNESS_PROBE_PORT` | Serve-probe bind port (default 18923, loopback only) |
| (none secret) | This procedure takes no credentials; if a probe asks for one, stop — wrong probe |

### Outputs

- One matrix row per harness, every cell labeled
  observed/collected/pending + dated.
- A proof note per observed row (command + output,
  machine + date, redacted).
- A re-check stamp: matrix date + which cells are
  older than ~30 days (rumors, flagged to presentation-layer).

### Verification

- Every observed cell traces to a command + output in
  a proof note; every collected cell to a cited source
  + capture date; pending cells name the owed probe.
- Gate green (`bun tools/check-skills.ts`).
- No creds/tokens/serials/IPs in skill or proof
  (grep for site-local/public patterns before finishing).
- No twin or router was contacted (proof states the
  non-contact explicitly).

### Recovery

- Serve probe port busy → pick another ephemeral port,
  record which; never reuse a port another service owns.
- `pkill -f` matching your own command → use the
  bracket trick (`1892[3]`), re-verify down with curl.
- Presentation fails despite a green matrix cell →
  the cell lied: reproduce, demote to pending with the
  failure output, record it in the handoff note, re-probe.
- Source doc stale (pricing moved, toolset drifted) →
  update the collected cell + capture date, or demote
  to pending if the new state is unverified.

### Limits

- Shell probes prove generation and serving, never
  in-owner-UI rendering: inline HTML/image/link cells
  need a UI-level probe this procedure cannot run alone.
- One machine's observed row says nothing about another
  sandbox (workstation KVM+loopback vs sandbox TCG+no-loopback).
- The matrix is a dated snapshot; catalogs drift (tool
  versions moved twice in October alone). Trust the
  stamp, not the table.
- This skill inventories surfaces; it never chooses the
  presentation — that is presentation-layer's decision, keyed off this matrix.
