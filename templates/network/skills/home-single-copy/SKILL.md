---
name: home-single-copy
description: "No-server local home: one laptop/desktop copy. Use when: bootstrapping or working locally, backup/restore questions, copy-this-tree or two-machine questions, or evaluating promotion to git."
topics: [workspace, backup, home]
tested: none
---

# `home-single-copy` skill (no-disk local home) [template v1 draft]

Vendored from the build notes for review with template v1. Build-tracker
references (T/K IDs, notes paths) are pointers pending staging scrub.
See also `home-private-git.md` (promotion target). No secrets below.

## Part 1 — The checklist (instantiate → protect → share → promote)

### 0. Decide this is the home

Use single-copy when the router has no usable disk, or the owner
simply wants one laptop/desktop copy. Zero ceremony, works fully
offline after tool install, lowest owner friction — and trivially
consistent, because there are no router-owned dirs to pull. This is
workspace-first in its purest form (K1): a prepared directory plus
conventions plus skills, no deployment anything.

### 1. Instantiate (minimal — grow on demand, K10)

1. Create the layout subset: START-HERE, `workspace.toml`
   (`home = "single-copy"`), `inventory/ observations/ operations/`
   plus `inbox/`. N=1 starts here and stops here.
2. Add `checks/ skills/ reports/ whiteboard/` only when something
   needs to live in them. Empty dirs are not instantiated to look
   complete.
3. Record trilogy pins in `workspace.toml` at bootstrap.

### 2. Backup discipline (the price of no server)

Single copy is a single point of loss. The skill requires, and the
owner provides (mechanism is the owner's choice — the skill states
the requirement, not the tool):

1. A backup exists, its location + cadence recorded in `workspace.toml`.
2. A restore was TESTED at bootstrap (date recorded). An untested
   backup is not a backup.
3. Session close never skips: uncommitted-thought vs unshaped-draft
   is tracked the same as the git home (§5.4 of the discipline
   carries over, minus git) — inbox + last summary tell the next
   session where things stand.

### 3. Sharing (manual until git — no second live copy)

1. Cross-session continuity is the tree itself: `inbox/` + last
   session summary (§4). There is no owner-facing share channel
   besides promoting to git (§5).
2. A second live copy is FORBIDDEN without the §5 guard. Sharing a
   file tree by copy/sync tools without declaring canonical is how
   networks silently fork.
3. Drive is never the share mechanism (`anti-drive-live`).
4. BUILD NOTE (not owner workflow): while routeros-muse is under
   construction, builder sessions additionally coordinate across
   habitats via the coord room (Gmail Drafts) — point at state, never
   paste copies. The room retires into GitHub mechanics once
   routeros-muse itself is on GitHub (D2/Q5 decided 2026-10-28).

### 4. Multi-session rule (one writer at a time)

1. Session open: read `inbox/` + the last session summary.
2. Session close: write the summary (what changed, what is pending,
   where state is).
3. Never assume the tree is as you left it — verify, then work.

### 5. Promotion trigger (T21 Q6 proposed answer)

Second machine, second agent, or owner request → the skill
AUTO-SUGGESTS bootstrapping `home-private-git` (T24 strawman §4).
Promotion requires the privacy scrub first (D1): raw pulls stay
behind, redacted summaries may travel. Until promotion, §3–§4 hold.

### 6. Second-copy guard

If a second copy appears anyway: declare ONE canonical in
`workspace.toml` immediately; the other carries an age manifest and
is read-only reference. Still never two-way sync (K12).

## Part 2 — Skill doc

### Trigger

Load when: bootstrapping or working in a no-server local home;
backup/restore questions; any "can I copy this tree / work from two
machines" question; promotion-to-git evaluation.

### Prereqs

- Local trilogy + pull/checker installed; disk space for captures.
- `workspace.toml` exists with home + pins; backup requirement (§2)
  satisfied before any real network state lands here.

### Access

- Local writes free. Router rules unchanged (reads-first, production
  writes need go-ahead, K14 for unknown operators).
- Sharing writes happen only via coord posts or git promotion — never
  by handing out live tree copies.

### Envs

None new. Transport auth reuses the t8-recipe envs (`CENTRS_*`,
CDB-first).

### Outputs

- Minimal layout + `workspace.toml` (home, pins, backup record).
- Per-session summaries in the tree (§4).
- Promotion suggestion with scrub checklist when §5 triggers.

### Verification

- Layout present, no unneeded empty dirs claimed as progress.
- Backup record exists with location + cadence + tested-restore date.
- No undeclared second copy (ask the owner when in doubt — forks
  hide in "oh, I also copied it to…").
- Checker exit 0 over captures worked this session; claims carry
  command + output (K23).

### Recovery

- Loss/corruption: restore from backup, verify with the checker,
  record the gap (what sessions are missing) honestly.
- Fork discovered: §6 guard immediately — declare canonical,
  manifest the other, reconcile by re-pull/re-do, never by blind
  merge of two live trees.

### Limits

- Single point of loss until promoted; the backup discipline is
  load-bearing, not advisory.
- Manual sharing; multi-agent use without git promotion forks
  silently — hence the §5 auto-suggest.
- No owner-facing share channel exists besides git promotion (coord
  is build scaffolding, D2/Q5 decided 2026-10-28).

## Part 3 — Assumptions (D2/T13 ratify; this skill assumes)

1. Coord room is build scaffolding only, never owner workflow (D2/Q5
   decided 2026-10-28); owner continuity is the tree plus git promotion.
2. Backup mechanism is the owner's choice; only the requirement +
   tested-restore bit are the skill's business.
3. §5 fires as an auto-suggestion, not an auto-migration — the owner
   approves promotion.
