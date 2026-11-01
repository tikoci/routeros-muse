---
name: anti-drive-live
playbook: false
description: "Stop-sign guardrail: Drive is never live interchange. Use when: any plan touches Drive for live state, FUSE flakes appear, or share/backup/second-machine questions arise."
topics: [drive, guardrail]
tested: none
---

# `anti-drive-live` skill (stop-sign guardrail) [template v1 draft]

Vendored from the build notes for review with template v1. This skill
says no; the yes lives in the four home skills in this directory.
No secrets below.

## Part 1 — The checklist (symptoms → stop → redirect)

### 1. Symptoms you are drifting toward Drive-as-bus

- Working files (plan, observations, captures, CDB, skills under
  edit) sit under a Drive/FUSE mount.
- "Sync will handle it" said about two writers, two machines, or
  agent + human editing the same tree.
- Whole-file replace races, conflict copies, or mystery reverts.
- Captures or credentials placed where Drive syncs them.
- Drive offered as the share/backup/second-machine mechanism for
  LIVE state.

Any ONE symptom fires this skill. The FUSE pain behind it is
load-bearing evidence, not taste (T21 §5).

### 2. Stop

Halt the Drive path immediately. Classify the underlying need: share
with whom, back up what, work from where. Do not "just this once"
live state through Drive.

### 3. Redirect

| Need | Correct home |
|---|---|
| Share across sessions/habitats | coord-room post with pointers (single-copy §3) |
| Share across machines/humans | promote to `home-private-git` (scrub first, D1) |
| Back up a local home | single-copy §2 backup discipline (owner mechanism) |
| Second machine, same network | git promotion — never a second live tree without the canonical guard |
| Hand someone a static snapshot | dated archive copy (see §4), explicitly stale |

### 4. Archive discipline (Drive's only job)

Drive stays a read-only reference and archive bucket. Any Drive copy
cited anywhere carries age + source exactly like any other
non-canonical copy (K12: other copies carry manifests stating their
age). A Drive file without a date on it is a rumor, not a record.

## Part 2 — Skill doc

### Trigger

Load when: any plan touches Drive for live state; FUSE flakes appear
in a session; §1 symptoms spotted in your own or another agent's work;
"where should I put this so X can see it" questions.

### Prereqs

None — this is a guardrail, not a setup flow.

### Access

Live writes to Drive mounts are FORBIDDEN. Reads of Drive-hosted
reference/corpus are allowed and stay read-only.

### Envs

None.

### Outputs

The redirect decision (§3 row chosen) recorded where the session
tracks decisions — so the next session does not re-litigate it.

### Verification

- No working paths (repo, captures, CDB, skills under edit) resolve
  under a Drive/FUSE mount. When in doubt: `df` the path and read
  the mount table.
- Cited Drive copies carry age + source; undated citations get dated
  or dropped.

### Recovery

- Live state found under Drive: move it to a real home
  (single-copy or private-git), verify with the checker, leave the
  Drive copy as a dated snapshot or remove it — never both-live.
- Sync damage (conflict copies, clobbered files): canonical home
  wins; re-pull router-owned dirs; reconcile agent-owned from history,
  never by merging conflict copies blindly.

### Limits

This skill only refuses. Affirmative hosting answers live in
`home-private-git`, `home-router-container`,
`home-router-disk-sync`, and `home-single-copy`.

## Part 3 — Assumptions

1. The Drive corpus stays the read-only archive (triage map unchanged).
2. No future "Drive sync got reliable" claim reopens this without new
   load-bearing evidence and a D-record decision.
