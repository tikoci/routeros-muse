---
name: work-flag-note
description: "Mark multi-step router work with the /system/note WIP flag: set before, clear after, empty means well. Use when: starting multi-step work on a shared box, spotting a non-empty note on login, or coordinating hands across sessions."
topics: [system-note, coordination]
tested: none
---

# `work-flag-note` skill (set → work → clear) [template v1 draft]

Skill form of K11 (concepts.toml:97-103): the `/system/note` WIP
convention. Small on purpose — this is a coordination habit, not a
procedure. Referenced normatively by `first-contact`, `change-apply`,
and `incident-response`. No secrets below.

## Part 1 — The checklist (flag the work, clear the flag)

Three steps, every time. The flag is a courtesy to the next hands,
human or agent — explicitly not a lock.

1. Set the flag BEFORE the first write: `/system/note/set
   note="WIP: <what> <date>"` — one line, what + when.
2. Do the work (the owning procedure's steps run here, flag set).
3. Clear the flag AFTER the last verify: `/system/note/set note=""`
   — and confirm it reads back empty.

### 0. Set (before the first write)

```sh
centrs execute --host <addr> --via native-api --format json -- \
  '/system/note/set note="WIP: UM db-path move 2026-10-29"' --yes
# twin path: centrs execute --quickchr <twin> '/system/note/set note="..."' --yes
```

- Format: `WIP: <short-what> <YYYY-MM-DD>`. Short-what names the job
  (change-apply plan name, incident id); the date says how stale a
  leftover flag is.
- Set BEFORE staging anything: the flag covers the whole change,
  including the staged-but-unrun window (change-apply step 4).
- Setting the note is itself a write: on production it falls under
  the same owner approval as the work it flags — ask once for
  "the change including its WIP flag", not twice.

### 1. Respect (what a non-empty note means)

- `/system/note` shows at SSH login: a non-empty note is the first
  thing the next hands see (K11; concepts.toml:97-103).
- Non-empty note + you did not set it → someone's work is in flight
  (or crashed mid-flight): read the what + date, check for staged
  scripts (`/system/script/print`) and artifact files before doing
  anything of your own.
- Stale flag (old date, no staged residue, owner confirms nothing
  running) → clear it and note the clear in your run record. Never
  clear a fresh flag without asking the owner — that is someone's
  live work.
- The flag is NOT a lock and NOT security: it coordinates willing
  parties; it enforces nothing. Cross-vendor convention (K11).

### 2. Clear (after the last verify)

```sh
centrs execute --host <addr> --via native-api --format json -- \
  '/system/note/set note=""' --yes
# confirm: read /system/note back — empty means well
```

- Clear AFTER verification passes, not after the last write: the box
  is "well" only when read-back confirms the intended state
  (change-apply: pristine-verify; incident-response: healthy triple).
- Confirm by read-back: an empty note is the done signal. A run that
  ends with the flag still set is an unfinished run — say so.
- Crashed sessions leave flags set: that is the design working (the
  next session sees WIP + stale date + residue and investigates
  instead of assuming well).

## Part 2 — Skill doc

### Trigger

Load when: starting multi-step work on a shared/twin box; spotting a
non-empty `/system/note` on login or in a capture; coordinating work
across sessions; any procedure says "set the WIP flag". (Entry-skill
+ capability-probe pattern: K22.)

### Prereqs

- Write access to the target (the flag is a write); approval for
  production covers flag + work together.
- The owning procedure loaded (change-apply / incident-response /
  twin bisection) — this skill flags work, it never defines it.

### Access

- Twins: set/clear freely as part of any multi-step run.
- Production: flag set/clear rides the work's owner approval; never
  a standalone unapproved write.
- Clearing ANOTHER session's flag: ask the owner first unless the
  flag is provably stale (old date + no residue + owner-confirmed).

### Envs

| Name | Use |
|---|---|
| `CENTRS_USERNAME` / `CENTRS_PASSWORD` | Host-path auth for the set/clear writes |

### Outputs

- Set record: flag text + timestamp (in the owning run's ledger).
- Clear record: read-back-empty confirmation.
- Stale-clear note: why judged stale + owner confirmation.

### Verification

- After set: `/system/note/print` shows the WIP text.
- After clear: `/system/note/print` shows empty.
- Run ledgers reference the flag lifecycle (set → work → cleared).

### Recovery

- Flag set fails → the box may be unreachable or denying writes:
  treat as a transport/auth fault (`first-contact` step 5), not a
  flag problem; do not proceed unflagged on a shared box.
- Found flag mid-work you did not set → stop, read it, investigate
  residue, escalate to the owner before continuing.
- Double-flag (two WIPs) → serialize: finish or hand off one job
  before starting the other; never interleave writes.

### Limits

- One flag per box: concurrent jobs on the same router serialize on
  the note. Parallel work needs parallel boxes (twins).
- The note is one line of text: job ids and dates, never secrets,
  never passwords, never tokens.
- `/export` includes the note: captures of a mid-work box show WIP —
  that is correct and informative, not leakage.
- Coordination only: nothing in RouterOS enforces the flag. Agents
  that skip it are rude, not blocked — review catches that.
