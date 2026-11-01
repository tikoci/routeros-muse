---
name: network-workspace-bootstrap
description: "Bootstrap a network workspace from the template: starter layout, writer/sync map, memory and handoff conventions, plus the fresh-session takeover test. Use when: creating a workspace from the template, adopting a tree you did not build, handing work to another session, or asking what lives where and who writes it."
topics: [workspace, inventory, onboarding, handoff, memory]
tested: none
---

# `network-workspace-bootstrap` skill (lay out → map → hand off → retake) [template v1 draft]

Promoted from the template build (layout, conventions, schema),
the home frame (writer/sync rules), and standing build practice
(handoff notes, ledger attach). Claims below are
collected (read, not re-run) unless labeled; sources
cited inline by path. No secrets below; devices are roles.

## Part 1 — The checklist (a stranger can take over)

Run top to bottom. The workspace is done when a fresh session,
reading only the tree, reaches working state without asking you
anything — §3 is that test.

1. Lay out the starter tree (§0): copy the template subset the home
   needs, fill workspace.toml + router.toml, no empties for show.
2. Draw the writer/sync map (§1): every directory gets one writer
   and one direction; second copies get age manifests, never merge-back.
3. Wire memory and handoff (§2): per-session summaries in-tree,
   ledger entries for runs, handoff notes while building.
4. Run the fresh-session takeover test (§3): cold read → probe →
   checker → first useful statement, all from the tree alone.
5. Record and close (§4): decisions logged, backup tested where
   required, pending listed honestly.

### 0. Lay out (N=1 start, grow on demand)

From the template README (layout rules):

- Copy the template tree to the new home, then instantiate ONLY
  what is useful: one `router.toml` plus one `observations/` folder
  is a complete N=1 workspace. Empty dirs to "look complete" are
  not progress (home-single-copy §1).
- Git homes lay the fuller skeleton (home-private-git §1):
  `START-HERE`, `AGENTS.md`, `workspace.toml`, `inventory/
  observations/ operations/ work/ checks/ skills/ reports/
  inbox/` plus `whiteboard/`.
  Single-copy starts smaller (START-HERE + workspace.toml +
  inventory/observations/operations + inbox) and adds the rest when
  something needs to live there.
- `workspace.toml` defines the setup (workspace-schema.md):
  `[home]` type + repo + canonical, `[pins]` trilogy versions,
  `[backup]` location/cadence/restore_tested, `[upstreams]` one
  direction per entry. Unpinned entries are TODOs, not defaults.
- `router.toml` names the one box by device (site-location-role job
  name; label is what's on the unit; serial binds at unbox, never
  before). Second box → per-device `<device-id>.toml` files under
  `inventory/` become canonical and root router.toml retires with a
  decisions.md entry (inventory/README.md).
- First commit is plan/skills/schemes/docs only — no pulls, no
  secrets, no site identifiers past the privacy line.

### 1. Map writers and sync (one writer, one direction)

From conventions.md + workspace-schema.md (writer/sync rules):

| Directory class | Writer | Direction |
|---|---|---|
| Agent-owned (`router.toml`, `inventory/`, `operations/`, `skills/`, `reports/`, `decisions.md`, docs) | this workspace | canonical here; edit freely |
| Router-owned (pulls under `observations/`) | the pull recipe | pull only; never edit a pull — re-pull or fix the router |
| Second copies of anything | nobody (reference) | age manifests; never sync back, never merge |

- One home is canonical (`canonical = true`); if two files both
  claim it, stop and reconcile before any other work.
- `[upstreams]` entries each name ONE direction: `push/pull` (git
  remote, main only), `pull only` (router-owned dirs), `deploy +
  read-back` (served artifacts). "Both ways" is forbidden, not
  discouraged. The disk-sync home's §3 table is this rule worked
  out for router-disk dirs.
- Plan-vs-capture disagreement goes on `operations/drift.md` or the
  router gets fixed; the plan is never silently rewritten to match.
  Capture boundary rides the map: raw `observations/*/
  pull-*/` local-only/ignored; redacted `summary.md` commits (device,
  three clocks, files + sizes + statuses, checker verdict). The
  documented redacted-override (multi-agent sharing) is stated only
  when asked, never volunteered.
- Second copy appears anyway → home-single-copy §6 guard: declare ONE
  canonical immediately, manifest the other read-only. No second
  live copy without the guard.

### 2. Memory and handoff (the tree remembers)

In-tree memory (owner workflow — survives promotion):

- Session open: sync canonical, pull fresh, run the checker, read
  ages (conventions.md). Single-copy shape: read `inbox/` +
  the last session summary; never assume the tree is as you left
  it — verify, then work (home-single-copy §4).
- Session close: commit shaped work, refresh summaries, leave the
  tree clean except ignored pulls — the next session reads inbox +
  last summary and knows exactly where things stand. Shaped records
  carry owner + DoD.
- Unshaped thought goes in `inbox/` or `whiteboard/` with no
  formality tax; anything needing action becomes a proposal under
  `operations/` with owner + DoD (START-HERE.md).
- Runs land in the evidence ledger: dated header + verbatim
  commands + outputs + labels (observed/collected/inferred/
  pending) + anomaly notes; the tracker points AT the entry.

Cross-session talk (workspace-native handoff):

- Handoff protocol: open by reading `inbox/` + the last session
  summary; close by writing a handoff note under `inbox/` or
  `operations/*-handoff.md` with what/where/next; long runs update
  the note as they go. Point at state (paths, commits, UIDs);
  never paste copies. Never edit another session's note — append
  a follow-up.
- Owner continuity is the repo itself: the tree plus handoff notes,
  no side channel.
- Pending is first-class: every handoff ends with unrun halves
  named with owners (evidence-ledger §4).

### 3. Takeover test (prove the handoff)

The test: a fresh session with only the tree + tools reaches a
first useful true statement without asking the previous session
anything. Shape from START-HERE first-session, the entry-skill
probe, and the acceptance sketch:

1. Cold read: AGENTS.md → START-HERE → conventions.md →
   workspace.toml + router.toml → inbox/ + last summary. Confusion
   here is a layout bug, not a reader bug.
2. Capability probe (blocked — manual until the probe lands): OS,
   trilogy versions vs workspace.toml pins, box reachability.
   Unpinned entries fail the comparison honestly.
3. Checker run: exit 0 over captures; the committed `_sample/`
   fixture proves the tool works on a fresh clone.
4. First useful statement: one true sentence citing data + time
   (device X pulled at T, checker verdict, drift count) — the bar.
5. Growth + scrub probes: simulate the second box (inventory/ rule
   fires, no silent fork), grep the session's `git log -p` for zero
   serials/creds/tokens/addresses, confirm no working path resolves
   under a Drive mount.

Pass = all five without side-channel questions. Failures file as
layout/handoff bugs, fixed in the tree, test re-run.

### 4. Record and close (decisions outlive chat)

- Log the bootstrap in `decisions.md` (id/date/title/decision/why):
  home type + why, instantiated vs deferred, backup mechanism
  + tested-restore date where required (home-single-copy §2 makes an
  untested backup a blocker, not advice).
- Record trilogy pins + repo provenance (URL + initial commit SHA)
  in workspace.toml.
- Builder sessions: handoff note (verdict + tree pointer + pending);
  tracker evidence pointer at the ledger entry.
- Pending list stays explicit: probe automation, second-box
  sim unrun, developer review of templates/network/ — each with its owner.

## Part 2 — Skill doc

### Trigger

Load when: creating a workspace from the template; first session in
a tree you did not build; handing work to another session; "what
lives where / who writes it / which copy wins" questions;
onboarding a second box, human, or agent. (Entry-skill +
capability-probe pattern.)

### Prereqs

- The template tree (v1) or an existing workspace to adopt; git on
  PATH for git homes.
- Trilogy installed + pull/checker recipe; versions comparable
  against workspace.toml pins.
- Scrub posture known for the first push (default: site content minus
  credentials stays unpushed to anything shared).
- Backup requirement satisfiable before real state lands on
  serverless homes (home-single-copy §2).

### Access

- Reads-first everywhere: cold read + probe + checker before any
  write, same as every home.
- Local/tree writes free; production router writes need go-ahead
  per item (the production rule generalized); Operator Unknown → ask
  before any write.
- Never edit a pull; never push agent edits into router-owned
  paths; never merge two live trees (reconcile by re-pull/re-do).
- Handoff notes are builder-talk: verdicts + pointers, no secrets,
  no pasted captures.

### Envs

| Name | Use |
|---|---|
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | commit identity for agent-authored commits |
| `CENTRS_*` / CDB-first | transport auth for pulls and probes (first-contact) |

No tokens, passwords, or CDB material in env for workspace
purposes. The repo credential is owner-provisioned at bootstrap
and lives in the deployment's own store, never in the repo.

### Outputs

- Bootstrap: instantiated layout + filled workspace.toml/router.toml
  + writer/sync map ([upstreams] + ownership) + decisions.md entry.
- Per session: shaped commits, refreshed summary.md files, checker
  verdicts cited by device + time, inbox drained or triaged.
- Handoff: session summary + ledger entry + handoff note
  + pending list with owners.
- Takeover proof: the §3 five-step result (pass, or filed layout
  bugs + re-run).

### Verification

- Layout: instantiated dirs all have residents; no unneeded empties
  claimed as progress.
- Map: every directory resolves to one writer + one direction;
  `git status --short` shows no `raw/` paths (ignore rule holds).
- Freshness: manifests fresh, checker exit 0 over every device
  worked; three clocks read correctly (content-changed vs
  last-observed vs last-attempted).
- Cleanliness: `git log -p` holds zero serials/creds/tokens/
  addresses (grep before push).
- Handoff: a stranger reaches the §3 first-useful-statement from
  the tree alone; every claim carries command + output.

### Recovery

- Takeover test fails on confusion → layout bug: add the missing
  summary/pointer/decision entry, re-run §3. Never "explain around"
  a tree gap in chat.
- Fork discovered (two live trees, two canonical=true) → §1 guard
  immediately: declare canonical, manifest the other, reconcile by
  re-pull/re-do, never blind merge.
- Dirty/conflicted sync → canonical home wins; re-pull
  router-owned dirs; revert bad commits with new commits, never
  rewrite pushed history.
- Checker nonzero → drift/incident input, never a cue to hand-edit
  raw/; captures are evidence, fixed by re-pull or router fix.
- Credential loss → stop, escalate to owner for re-provisioning;
  never improvise a credential to unblock.

### Limits

- WITH-SOURCE DEDUPE vs the home-* frame (answered by
  reading all four home skills + the design notes): each home skill
  owns ONE home type's loop (git: bootstrap/branching/session;
  container: enablement/deploy/crons; disk-sync: pull-first/sync
  rules; single-copy: minimal/backup/promotion). This skill owns
  the HOME-AGNOSTIC layer beneath and across them: the starter
  layout all homes instantiate from, the writer/sync map
  every home obeys, the memory/handoff conventions, and
  the takeover test proving any home adoptable. Boundary: homes
  say how to LIVE in a home; this says how to BUILD one and PROVE
  the next session can take it. No duplication: this cites homes
  per-home, homes cite this for bootstrap/memory/takeover.
- The entry skill + capability probe is BLOCKED on the template: the §3
  probe step is manual until the probe lands; environment-specific probe
  scope is itself open.
- Acceptance halves (lifecycle pass vs twin, second-box sim,
  scrub grep) are unrun: takeover steps 4–5 are prescribed, not
  yet executed — the first runner grounds them.
- Handoff here is workspace-native: session summary + ledger entry +
  handoff note, all in the tree.
