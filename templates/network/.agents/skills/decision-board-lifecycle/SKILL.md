---
name: decision-board-lifecycle
description: "Run a whiteboard from sketch to verdict: author the fragment, discuss and revise on a stable page, link the decision and work records, retire the board without losing either. Use when: the owner must choose between options, a change needs a temporary explanation page, a discussion artifact outlived its discussion, or asking where a past verdict lives."
topics: [whiteboard, decisions, owner-ux]
tested: none
---

# `decision-board-lifecycle` skill (author → discuss → link → retire → correct) [template v1 draft]

Promoted from a whiteboard contract
(source-verified in a private workspace checkout),
presentation practice from earlier field runs, demo
beats O1–O3, and the
`/app` deployment semantics (re-read on request, verified).
Core rule: a board is DISCUSSION — not
authorization, not the accepted plan. Decisions belong in the
decision register; agreed work belongs in the backlog. No secrets
below; boards carry shapes and estimates, never credentials.

## Part 1 — The checklist (a stranger finds the verdict)

Run top to bottom. The lifecycle is done when the board is
retired and its verdict still resolves: decision + work record
linked, nothing load-bearing left only on the board.

1. Author the board (§0): metadata comment + HTML fragment, no
   formality tax for a sketch.
2. Discuss and revise (§1): stable page, answer-first,
   estimates marked, cited specs.
3. Link the verdict (§2): draft → discussed → accepted or
   superseded, with links to the decision and work record.
4. Retire without losing (§3): archive the board, keep the
   decision and records, name the superseder.
5. Deploy and correct (§4): re-read semantics, PNG delivery,
   correction flowback.

### 0. Author (a fragment, not an app)

Source-verified contract (collected: the concept review): the
workspace's `whiteboard/` holds HTML fragments with a small
opening metadata comment. The portal discovers them, sorts by
date, lists summaries, and wraps each in normal navigation and
theme. Existing boards combine proposed changes, drawings,
materials, estimates, open questions, and installation
instructions — substantially richer than a chat answer or a raw
config diff.

```html
<!--
title: Guest access repair options
status: draft
date: 2026-10-23
summary: Two options for restoring guest access, with tests and remaining questions.
-->
<div class="wb">
  <h2>What changes</h2>
  <p>...</p>
</div>
```

- The contract is four fields: `title`, `status`, `date`,
  `summary` — plus the fragment. That is the whole authoring
  surface an agent must produce (collected: the contract's
  schema table).
- Template posture (observed `templates/network/whiteboard/README.md`):
  working drafts, no formality tax. Drafts link forward to the
  decision or proposal they become; the board itself never owes
  structure.
- Future fields ONLY if discovery outgrows file metadata: `kind`,
  related site/device/incident IDs, source revision, generated
  time, status, superseding artifact — plus a small artifact
  index if needed. Avoid mandatory lifecycle bureaucracy for a
  one-off sketch (collected: the contract's recommendation).
- Making an explanatory page is an ordinary tool of
  conversation: it must not require commissioning a permanent
  app or a product-building workflow every time (collected:
  a lesson for Muse). Demo status: metadata contract
  journaled, Muse-generated boards design (collected: demo
  beat O2).

### 1. Discuss (stable page, answer first)

What works in the structure (collected: the whiteboard contract): a human returns to
a stable page, compares options, points to a drawing, and asks
for revision; the agent modifies the artifact as the discussion
develops. Shared styling and navigation make a temporary
explanation feel like part of the workspace.

- House rules for board prose (collected: the whiteboard contract +
  the owner-deciding row): plain words, the ANSWER before the
  numbers, estimates marked as estimates, cited specifications.
  Owner-deciding shape: the answer first, options, what the test
  showed, what it can't show, estimates marked.
- Pre-apply beat O2 (collected: a demo run): before applying a
  change, the temporary page says what's broken, what it will
  change, what the test showed, and what it can't prove — then
  the owner asks about one part of it. "What it can't prove" is
  load-bearing, not modest: it scopes the approval.
- Field sheets are the same pattern aimed at hands work
  (collected: the whiteboard contract): generate the artifact for the person's
  immediate task — device labels, ports, a picture, an
  observable success check — all deriving from the same records
  without forcing the same screen on reviewer, installer, and
  remote diagnostician. Accompany field actions with "expected
  result" and "if this does not happen, stop and report this
  observation" — a checked box is not remote proof of a cable
  move.

### 2. Link (the verdict lives elsewhere)

- The boundary (collected: the whiteboard contract): draft → discussed/revised →
  accepted or superseded, WITH LINKS from the board to the
  actual decision and work record. The lifecycle is a
  recommendation, not an existing automated state machine —
  implement it as links and statuses, not workflow software.
- Provenance pattern (collected: the inputs list):
  `operations/decisions.toml` (D-01, D-02, D-08 shape),
  `operations/backlog.toml`, and whiteboard commit history
  together carry ownership, identity, capture provenance, and
  recorded evolution. A board that cannot point at its decision
  entry is still a draft, whatever its status field says.
- Review-against-shape: every accepted board resolves to one
  decision entry (id/date/title/decision/why) and zero or
  more backlog/work items with owners. Superseded boards point
  at the superseding artifact, never into the void.

### 3. Retire (archive the page, keep the meaning)

- Retiring = the board leaves the live list with its links
  intact: decision entry stays, work records stay, the fragment
  archives (or deletes, once nothing points at it except
  history). "Make a temporary page to help the owner decide"
  includes how to retire it without losing the decision
  (collected: the whiteboard contract).
- Dashboard-panel precedent O1 (collected: a demo run): during
  an incident the agent adds a TEMPORARY panel (Wi-Fi logins,
  reboot times, check results), then archives it when resolved
  while keeping the incident record. Statuses: router-hosted
  dashboard journaled (long-running),
  equipment-aware views journaled, agent-added panels design.
  Proposed close-out line: "I added a panel comparing guest
  checks, uplink loss, and recent changes; now resolved, I can
  archive that view while retaining the incident and
  observations" (collected: the whiteboard contract — proposed
  workflow, not an existing autonomous feature).
- Generated explanations and widgets may evolve; the meaning of
  a measurement must not change silently. Do not regenerate the
  whole interface on every poll (collected: the dashboard
  guidance).

### 4. Deploy (re-read rules, PNG delivery, corrections back)

- Deployment semantics (verified, collected: the agent-feedback
  notes): a change to the app's SCRIPT needs an `/app`
  restart; data files and whiteboard pages are RE-READ ON EACH
  REQUEST. Editing a source checkout does not update the
  router's copy. Different edits have different publication
  behavior — put reload/restart semantics in the recipe; do not
  guess (collected from pilot feedback).
- PNG delivery for the non-expert owner (journaled, collected
  from earlier field runs): the owner looks at things on a phone in
  a text thread, so the useful output is often a PNG, not a web
  page — 1080×1350 phone-portrait pages, `?p=N` rendering one
  page, headless Chrome screenshotting each to its own PNG for
  iMessage/RCS. Whiteboards show up on the dashboard and can be
  screenshotted the same way. Day-0 ASK MUSE checks (still
  open): can a sandbox-generated PNG/HTML be shown inline in the
  app on the phone? Is a headless browser available in the sandbox?
  Do tile/endpoint hosts pass the egress proxy?
- Correction flowback O3 (collected: the whiteboard contract + a demo run): the
  map's "Fix GPS" mode is the concrete human → artifact → agent
  → structured-record loop — drag pins, edits persist in browser
  localStorage, the page copies TOML-like corrections (original
  position + movement distance) for pasting to the agent, plus
  KML export; when regenerated data already contains a
  correction, the page clears the local edit within tolerance.
  Limits that travel with the pattern: browser-local edits are
  NOT inventory updates; copying a correction is NOT proof the
  agent applied it; the page text must say "copy changes for
  your agent" (it names a specific agent today); recommended additions are
  a revision identifier and a visible saved / applied-to-
  inventory / published distinction. Generalize to port-label
  corrections, "this device is in the other room", annotated
  install photos, proposed cable routes, field checklists — a
  page emits structured feedback WITHOUT permission to change
  the network itself.

## Part 2 — Skill doc

### Trigger

Load when: the owner must choose between options; a change
needs a temporary explanation page; a discussion artifact
outlived its discussion; "where is the verdict for X"
questions; retiring a dashboard panel or board; correction
flowback design. (Entry-skill + capability-probe pattern.)

### Prereqs

- The workspace tree with `whiteboard/` + decision register +
  backlog (template shape observed).
- The serving path known (router `/app`, local render, or chat
  PNG) with its reload semantics stated, not assumed.
- For PNG delivery: a headless renderer available, or the
  sandbox checks in §4 run first.

### Access

- Reads-first: read the board + linked decision + work record
  before revising any of them.
- Boards are discussion: editing a board never authorizes the
  change it discusses — authorization lives in the approval
  path (adversarial-review, change-apply).
- Retiring deletes discussion, never decisions or evidence —
  confirm links resolve before archiving.
- Owner-facing pages carry no credentials, serials, or private
  addresses — map-less boards get the same scrub as published
  ones (pre-publish-scrub).

### Envs

| Name | Use |
|---|---|
| (none required) | Board authoring is file writes + renders; no service env |

Renderer paths (headless browser binary, tile endpoints) are
recorded in the workspace, not env. No tokens or credentials
take part in the board lifecycle.

### Outputs

- Board fragment with the four-field metadata comment.
- Discussion revisions on the stable page.
- Decision entry + work-record links (accepted) or superseder
  link (superseded).
- Retired board: archived with links intact, or deleted with
  history citing it.
- PNG renders where the owner reads on a phone.

### Verification

- Every non-draft board resolves: accepted → decision entry +
  work items; superseded → superseding artifact. Dangling
  verdicts fail.
- Board prose audit: answer first, options, test-showed /
  can't-prove, estimates marked, specs cited.
- Deployment check: reload/restart semantics stated in the
  recipe and matching observed behavior (re-read vs restart).
- Correction-loop check: saved / applied / published states
  distinguishable; no claim that a copied correction was
  applied without the record showing it.
- Claim audit: each lifecycle claim carries command + output
  or an honest collected/pending label.

### Recovery

- Board edited but serving stale → check the §4 semantics
  (fragment re-read vs script restart vs checkout-not-deployed)
  before re-editing.
- Verdict lost (board retired, decision missing) → reconstruct
  from commit history + linked records, file as a lifecycle
  bug, re-link before closing.
- Owner acted on a draft → mark the board, record what was
  decided where it actually was, link it; drafts that authorize
  are the failure mode §2 exists to prevent.
- Correction applied nowhere → re-run the O3 loop explicitly
  (paste → apply → regenerate → owner confirms in the view).

### Limits

- The lifecycle is a recommendation with source-verified
  fragments — no automated state machine exists; links and
  statuses are the whole implementation until built.
- Muse-generated boards and agent-added panels are DESIGN, not
  running features — quoted as pending, never as available.
- Sandbox delivery checks (inline PNG, headless browser,
  tile egress) are open ASK MUSE items — phone delivery is
  proven on the macOS path only.
- One-off sketches owe no bureaucracy: forcing the full
  lifecycle on a sketch is a heavier failure than skipping it.
