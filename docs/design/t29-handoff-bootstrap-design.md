# T29 — muse-app (VM) to local `muse` handoff + `bunx` bootstrap [STRAWMAN 2026-10-31]

Status: Final — accepted 2026-10-31 as amended (D20). No build
yet: implementation starts on a separate explicit go, after a
spawn-health check. Records: D10–D20, K29, T29 done, T30/T32
ready, T31/T33 blocked. No secrets below.

## 0. The problem, restated

The VM session (muse-app / desktop cloud) can discuss and design,
but it cannot execute: no local terminal, no KVM, no LAN to the
router, no local `centrs`/`quickchr`/`rosetta`. The local PC can do
all of that, but today starting there is manual folklore.

So the product gap is not chat. It is a clean, one-line path from
"I designed this in the VM" to "`muse` is running on my PC, in the
right workspace, able to reach my network." Everything below serves
that path. The shared workspace directory stays canonical (D2/K12);
this track is the door into it, not a replacement for it.

## 1. Principles (inherited, not new)

- Bun is the only prerequisite we may assume we can ask for. The
  tikoci trilogy already requires it. One install line, then `bunx`.
- The workspace is files. Git is the default home; a synced folder
  (Dropbox etc) is a legal home. Anything we build must see only
  files, so both homes work without special cases.
- The VM never claims execution. Its outputs are labelled
  unverified until a local run supplies command + output (K23).
- No tunnel tricks as the main path. No Cloudflare door from the
  cloud VM into the home LAN. If a live bridge is ever wanted, it
  is initiated outbound from the local PC, never inbound to it.
- No harness fork yet. T3 Code is the future direction and the
  visual inspiration. The repo stays harness-agnostic until use
  proves a network-specific UI is worth maintaining.

## 2. The handoff artifact (design in VM, execute locally)

The VM session ends by writing one shaped file into the workspace:

- Location: `operations/<id>-handoff.md` (shaped) or `inbox/`
  (unshaped). Shaped needs an owner + a definition of done (K15).
- Contents: goal, constraints, proposed steps, which twin/box each
  step needs, and every claim labelled `unverified (VM design)`.
- Sync carries it to the PC (git pull, or folder sync). The local
  session opens with the takeover test (`AGENTS.md` step 4):
  pull fresh, checker, read the handoff, restate capability mode,
  then execute or explain why a step cannot run here.

This file handoff works today with zero new code. T30/T31 exist to
remove the manual setup around it, not to replace the artifact.

## 3. What the VM says (the whole owner-facing surface)

One paragraph, pasted by the VM session or shown in the app:

> To run this on your network: install Bun following Bun's own
> instructions (the same start as the other tikoci tools), install
> `muse` and sign in, then run `bunx routeros-muse`. It will check
> your machine, open your network workspace, and tell you the exact
> next step. Nothing installs without asking you.

That is the contract. If the bootstrap needs a second paragraph of
caveats, the bootstrap is wrong, not the paragraph.

## 4. `bunx routeros-muse` — what happens after (T30 strawman)

Ordered, each step reports or asks; no silent installs:

1. Prereq check: bun (present by definition), git, OS/arch. QEMU +
   KVM are checked but optional — only twin work needs them, and
   their absence degrades to "real-box only," never to failure.
2. Tool pins: install or verify `quickchr`/`centrs`/`rosetta` at
   the `workspace.toml [pins]` versions (global bun installs, the
   orca-proven pattern). Version mismatch is reported, not fixed
   silently.
3. Agent check: is `muse` present? Ideally install it if
   possible (D20): the official user-level path, echoed, under the
   one-yes — falling back to print-and-stop with a resume command
   where install is not possible. If present but unauthenticated,
   walk the owner through its auth flow; never collect or store
   the credential — auth lives in `muse`'s own store, creds for
   routers in the CDB (D8), nothing in the workspace.
4. Workspace: clone (git home) or ask for the folder (synced home),
   then validate: `workspace.toml` parses, exactly one
   `canonical = true`, `AGENTS.md` present. A Dropbox-style home
   with conflict copies is detected here and refused with the
   single-canonical guard, not merged.
5. Capability probe (the T15 probe, folded in): shell, tool
   versions vs pins, twin reachability, LAN router reachability.
   Prints the mode: full / real-box-only / design-only.
6. Handoff read: list `operations/*-handoff.md` + `inbox/` items
   the VM left, newest first, and print the exact launch line for
   the chosen mode in §5.

Settled (D11/D13/D14): unscoped `routeros-muse`; the human has
already installed Bun (per Bun's instructions) + `muse` before
kickstart, and the bootstrap may then install itself globally.
After one yes it runs echoed user-level installs; system-level
installs stay print-only from the bootstrap itself. `--yolo`
forwards to the `muse` launch (the agent's approval mode), not
to sudo. Platform order: Mac first, Windows second once a
Windows+T3 box exists for the agent, Linux last and agent-guided
from a shared-directory setup list. Still open (§8, item 4):
that setup list's shape — and Mode B's doctor renders the same
list, surfacing missing/recommended tools (brew optional but
recommended on Mac) for the agent to prime.

## 5. After bootstrap: two launch modes

**Mode A — CLI (ship first).** Bootstrap ends by launching (or
printing) `muse` in the workspace directory. Ugly, zero new UI,
works with every home and every future harness. This completes the
demo honestly: VM designs, local `muse` executes via `centrs`.

**Mode B — Bun server + ACP (T31, spike-gated).** `bunx
routeros-muse serve` starts a loopback Bun server over the same
workspace: tree + drift + observations on the left, a deliberately
small chat pane on the right that talks ACP to the local `muse`
only. T3-inspired look, a fraction of T3's scope: no multi-agent,
no general chat features, one workspace, one agent. Because it
only sees files, git and Dropbox homes behave identically. Mode B
adds the doctor (D14): missing and recommended tools from the
shared setup list, surfaced in the UI with a “have the agent fix
this” prompt — priming the Mac for later network work, not a hard
gate. Mode B also adds the render path (D17, critical): the agent
writes a non-Markdown artifact (map, SVG, chart, HTML view) into
the shared workspace and Mode B renders it for the human. The
existing presentation-layer renderer (self-contained offline
HTML/SVG/PNG; topology via deterministic DOT-to-SVG) is the
grounding pattern, not generated pixels.

Layout (D18, T3 Code as the model with one correction): chat
sessions do not own the left pane. **Left** lists known
routers/devices (`router.toml`/`inventory/` + latest observation
summary per slot), each with a start-chat action that seeds a
conversation with that device's context; sessions are at most a
minor list under it. **Center** is ACP chat with the local
`muse` about the selected device/workspace: still one agent
(no multi-agent), but with a start-new/reset for the current
session and a context display when useful (D20). **Right** is
tabbed Render (artifacts, expandable) and Status (doctor tiers,
drift, capability mode).

Audience and polish (D19): the user is a RouterOS admin who may
have never touched an AI coding tool. Plain words, working
defaults, no exposed machinery — seamlessness within the safety
tiers is what refines the controls. Rendering is two tiers
(static default; sandboxed-interactive when needed), and the
backend grows named render services (topology, map, chart,
report) so the agent's non-text path is paved and common, not
invented per chat. centrs/quickchr/rosetta each surface here in
network terms. T3 Code is overkill as a product but is the polish
model; UI specifics come back as reviewed concepts (T32) —
slop is a review failure, not a style note.

Updated by D16 (demo scope): A is the stepping stone and gate;
B's split-panel demo is the Stage 1 goal. Building B still waits
for the ACP spike and a separate explicit go.

## 6. Repo-shape impact (why this gates the freeze)

- `template/` stays harness-agnostic and gains only what landed
  today: `AGENTS.md` (agent entry pointing at `START-HERE.md`) and
  `work/` (agent-built code/projects, the heltec-victron parable's
  home). No server code enters the template.
- The `routeros-muse` package is builder/product code, not owner
  workspace content. At T14 staging it wants its own top-level home
  (alongside `template/` + `tools/`), with `tools/` keeping the
  pull/checker executables it orchestrates. Freezing T14 before
  this ruling would bake in the wrong top level.
- `workspace.toml [pins]` becomes load-bearing: the bootstrap is
  its second consumer (after the probe). Unpinned entries block
  bootstrap with a named TODO, per the schema.

## 6b. Doctor spec shape (D15)

One machine-readable file shipped with the package (Mac first),
plus optional workspace additions merged on top — never a fork.

Each entry (one per tool, per OS where it differs):

- `id`, `os` (`mac` first; `windows`/`linux` stubbed until their turn)
- `tier`: base urgency — `required` (blocks a capability mode) |
  `recommended` (primes the mainstream workflow) |
  `helpful` (boosts a specific task; never blocks anything).
  Tiers are contextual, not absolute (D20): the `skills` refs may
  escalate an entry for that skill — `required-for-this-skill`,
  or highly recommended where the tool avoids a much harder agent
  path. An esoteric skill surfaces its need when invoked, at the
  escalated level, instead of nagging globally up front
- `detect`: a check command whose exit status answers “present?”
- `hint`: install suggestion (manager-appropriate, e.g. `brew`;
  a hint, not an installer — D14 keeps system installs agent-guided)
- `why`: one line the doctor UI can show verbatim
- `skills`: cross-references — skills that require or benefit from
  this tool, so a missing `helpful` tool surfaces exactly when its
  skill is about to run, not as generic nagging

Consumers, all reading the same file: the Mode A bootstrap check,
the local agent working a Linux/Mac setup, and the Mode B doctor UI.

## 7. Risks and honest gaps

- ACP surface of `muse` is assumed, not probed. Mode B's first
  step is a hello-world ACP spike; failure there kills B, not A.
- `bunx` on a machine without Bun still needs the Bun install line
  per OS. That line is OS folklore until tested on a clean PC.
- Folder-sync homes can create conflict copies mid-session. The
  canonical guard detects; it does not prevent. Git stays default.
- Muse auth UX is `muse`'s, not ours. We can guide and detect,
  never smooth over a broken login. The bootstrap must say so.

## 8. Rulings

1. **SETTLED (Final, D11).** Mode A first; Mode B spike-gated second.
2. **SETTLED (Final, D11 + D13, corrected by D14).** Unscoped
   `routeros-muse` (registry 404 = unclaimed 2026-10-31; valid
   npm naming; `bunx` resolves it). Consent: one-yes echoed
   user-level installs, print-only system-level; `--yolo` forwards
   to the `muse` launch only.
3. **SETTLED (Final, D12).** Handoff artifact at
   `operations/<id>-handoff.md` (agent-first: one glob finds all
   pending work; no new dir at N=1). Developer hard requirements
   recorded in D12: seamless handoff + dirt-simple `bunx
   routeros-muse` path to RouterOS via twins-then-box.
4. **SETTLED (Final, D14 + D15).** Humans install Bun + `muse`
   first; Mac first, Windows second (needs a Windows+T3 box before
   CI), Linux agent-guided. `--yolo` belongs to the `muse` launch,
   not sudo. The setup list is a packaged machine-readable doctor
   spec plus workspace additions, with `required`/`recommended`/
   `helpful` tiers and skill cross-refs (§6b).
5. **SETTLED as modified (Final, D16).** Stage 1 is a demo:
   Mode A first as the stepping stone/gate, Mode B split-panel
   demo as the goal (CLI alone is too loose; docs surfaced in web
   panels are the point). Deferred: Windows, Linux installers,
   publishing, general harness features. Within the boundary the
   lane stops only for creds/auth, elevation, real-box writes,
   publishing, or scope widening. Panel composition settled
   (D18: devices left, chat center, Render/Status right) and
   rendering settled (D19: two tiers, backend render services,
   admin-friendly polish, concepts reviewed before build).
   Accepted as amended 2026-10-31 (D20). This acceptance does
   not itself authorize a build; implementation starts on a
   separate explicit go, preceded by a spawn-health check.


