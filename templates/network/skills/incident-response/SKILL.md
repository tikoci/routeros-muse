---
name: incident-response
description: "L1 incident flow: pull-first evidence, compare against last-good, reproduce and bisect on a twin, fix, verify, close with proof. Use when: anything on a router breaks, a scheduled check goes red, or a failure needs a twin bisection."
topics: [incident, diagnosis]
requires: [twin]
tested: none
---

# `incident-response` skill (pull → compare → bisect → fix → verify) [template v1 draft]

Promoted from the executed UM bisection campaign (a twin depth/disk
matrix + a 7.25 version-axis repeat: 6 reboot cycles, all with
command + output) and the deterministic-incident concept. The
GENERAL playbook is new; every procedure below ran verbatim on twins.
No secrets below.

## Part 1 — The checklist (evidence first, restraint always)

Run top to bottom. Touch nothing on the failing box before step 1
completes — the first read is the evidence everything else stands on.

1. Pull the failing box NOW (state-pull): a timestamped capture
   before any probe, so the failure state is preserved verbatim.
2. Compare against last-good: diff the fresh capture against the
   previous capture and the plan; file the disagreement (drift list
   or incident record) before theorizing.
3. Reproduce on a twin at matching firmware: build the twin, replay
   the failing shape, confirm the SAME signature (not a similar one).
4. Bisect one axis per cell: depth, disk, version — record pre/post
   state per cycle in a results table until the failure axis is named.
5. Fix on the twin, verify the fix survives the trigger (reboot /
   re-check / second cycle), then change-apply to production and
   close with the evidence packet.

### 0. Restraint rules (read before acting)

- Evidence first: pull, then compare, then touch. An incident worked
  without a first capture is an anecdote, not a diagnosis.
- Reproduce before claiming: "X causes Y" is unproven until a twin
  shows Y with X and not-Y without X in the same session.
- One axis per cell: a bisection cell varies exactly one thing
  (depth OR disk OR version). Multi-axis cells prove nothing.
- Never experiment on production: twins exist for bisection;
  production gets only the verified fix via `change-apply`.
- Claim discipline: every result states its limits (CHR has no
  radios, x86 package gaps vs ARM hardware); observed vs inferred
  links marked separately.

### 1. Pull + compare (the first 10 minutes)

```sh
bun pull.ts --host <addr> --name <device> --out out   # or --quickchr <twin>
bun checker.ts --device <device> --out out              # clean before consuming
diff -r out/<device>/<prev>/ out/<device>/latest/       # what changed
```

- Grounded shape: the UM campaign compared db-size/users/log triples
  across every cycle — define YOUR triple
  (the 2–4 reads that fully describe the failure) before probing.
- Consult the failure signature first: `db-size 0 + users empty +
  "Database disk not yet usable"` MEANT the UM wedge, not a mount
  problem — the disk showed mounted and sqlite files intact.
  Signatures beat theories.
- Check the log for the error line AND its persistence: errors still
  firing 25 min post-boot ruled out a slow-mount race without any
  further test.
- File the disagreement now: drift list (plan-vs-capture) or incident
  record (last-good-vs-now). Never rewrite the plan to match.

### 2. Reproduce on a twin (same signature, not similar)

```sh
quickchr add --name <twin-n> --version <same> --add-package <pkg> --add-disk 512M
quickchr start <twin-n>
# replay the failing shape, then confirm the FULL signature matches
```

- Grounded: one twin was built per recipe (7.26beta3 + user-manager +
  512M second disk) and reproduced the incident after a clean reboot;
  a second twin repeated cell C2 on 7.25 with a
  byte-identical pre-reboot signature (148.6KiB / 48.0KiB / 100.6KiB).
- Match firmware first: the version axis is real until proven
  otherwise. The second twin existed because 7.26beta3-only proof
  left 7.25 open.
- Pre-reboot HEALTHY baseline is mandatory: record the healthy triple
  before the trigger, or the post-trigger state proves nothing.
- Never delete the standing pair (twin-ops); make your own dirty-work
  box for destructive probes. Leave other sessions' twins untouched
  (the twin-ops non-disturbance pattern).

### 3. Bisect (the method, verbatim from the UM campaign)

Per cycle: configure the cell, add the probe object, record
pre-trigger state, fire the trigger, wait, confirm the trigger
actually happened (TWO signals), record post-trigger state.

```sh
# trigger: reboot from inside RouterOS (connection drop is EXPECTED)
quickchr exec <twin> "/system/reboot"
# -> Error [EXEC_FAILED]: ... {"detail":"interrupted",...}  (expected)
sleep 55
# fresh-boot confirmation needs BOTH:
quickchr exec <twin> "/system/resource/print"   # uptime ~50s AND ...
# ... write-sect-since-reboot reset to a small value (proves new boot)
```

- Grounded: the method block ran 6 cycles unchanged.
  Uptime alone is
  not proof — the write-sect reset discriminates real reboots.
- Cells from the campaign (depth × disk matrix):
  S1 depth-1 second disk PASS; S2/C2 depth-2 second disk FAIL (two
  name sets, ruling out names); B2/B3 2–3-component boot disk PASS;
  depth-0 rejected at set on both disks.
- Verdict rule: the failure axis is the SMALLEST conjunction the
  cells support — here "second disk AND ≥2 levels below mount".
  Not pure depth (B3 survives), not
  names (C2 reproduces), not a race (25+ min persistence).
- Untestable cells are N/A with reason, never skipped silently:
  depth-0 rejected ("Directory needs to be empty OR have a valid
  userman-5 database"; mount roots hold lost+found).

### 4. Recovery probes (ladder before declaring unwedgable)

When the failure state resists the obvious fix, climb the ladder —
each rung is one command + observed output:

1. Re-set the SAME config (rules out transient write loss) — UM:
   still db-size 0.
2. Disable/re-enable the subsystem — UM: `/user-manager/set` ITSELF
   errored; fully wedged, no in-place recovery.
3. Second trigger with no config change (rules out one-shot races) —
   UM: still failing, deterministic.
4. Point at FRESH state (new dir / new object) — UM: immediate
   recovery, db-size + free-space back; the ONLY escape.

- Persistence probes (+3 min re-check) rule out slow races cheaply.
  Run one before any ladder — a self-healing box needs no bisection.
- A rung that errors IS data: "even enabled=no is rejected" named
  the wedge depth.

### 5. Fix, verify, close (the evidence packet)

- Fix on the TWIN first: apply the candidate fix, re-fire the
  trigger, confirm the healthy triple survives. Unverified fixes
  never reach production.
- Production fix rides `change-apply` (propose → stage → run →
  read back → clear). The incident record links the proposal.
- Verify survivor state on production with the same reads as the
  twin (db-size/users/log triple pattern), plus a persistence
  re-check minutes later.
- Close with the evidence packet: failing capture timestamp +
  results table (cell/pre/post/verdict) + fix commands + post-fix
  verification + limits. Undone stays listed, never dropped.

## Part 2 — Skill doc

### Trigger

Load when: anything on a router breaks or misbehaves; a scheduled
check goes red; a failure needs twin reproduction; "is this the UM
wedge / a known signature" questions. (Entry-skill +
capability-probe pattern.)

### Prereqs

- `state-pull` available (step 1 runs it); a twin device free or a
  matching twin already running (`quickchr list`).
- Last-good capture or plan to compare against; without a baseline,
  step 2 compares against the design docs, honestly marked.
- Firmware version of the failing box (the twin must match it).

### Access

- Failing production box: pull + reads only until the fix is
  twin-verified. No experimental writes, no reboot-to-see.
- Twins: anything goes; never delete the standing pair; respect other
  sessions' machines (list PIDs at session start/end).
- Production fix: owner approval per `change-apply` (reads free,
  ANY write asks first).
- WIP flag on shared boxes for multi-step work.

### Envs

| Name | Use |
|---|---|
| `CENTRS_USERNAME` / `CENTRS_PASSWORD` | Host-path pull auth |
| `CENTRS_TIMEOUT` | Raise for slow-box reads during incidents |

### Outputs

- Failing-state capture (timestamped) + checker-clean verdict.
- Failure signature: the 2–4 reads that fully describe it.
- Results table: cell / varied axis / pre / post / verdict.
- Named failure axis (smallest supported conjunction) + limits.
- Fix proposal + twin verification + production read-back.
- Closed incident record with the full evidence packet.

### Verification

- Signature reproduced on a twin, byte/shape-identical to production.
- Fresh-trigger confirmation used two independent signals.
- Fix survives the trigger on the twin AND a persistence re-check.
- Production post-fix reads match the healthy triple.
- Claim discipline: command + output for every row in the table.

### Recovery

- Twin build fails → check cached images (`chr-<ver>.img`); package
  zips fetch from download.mikrotik.com at first start.
  No cache + no network = blocked, say so.
- Trigger didn't fire (uptime high, write-sect unreset) → the cycle
  is void; re-fire, do not record post-state against a stale boot.
- Bisection inconclusive after the budget (~45 min / 5 cycles filled
  the UM matrix) → record the table as
  far as it goes, name the next axis, hand off honestly.
- Wedged beyond the ladder → escalate with the ladder outputs; the
  fresh-state escape (rung 4) is last resort, data loss stated.

### Limits

- Twin proof is CHR proof: no radios, x86-only packages, CHR lacks
  `/system/routerboard`. Radio-adjacent failures need hardware.
- Single-axis cells only; version-axis repeats are separate builds
  (second-twin pattern), not assumptions.
- The campaign this playbook generalizes took ~45 min for 5 reboot
  cycles — budget bisections, don't open-endedly probe.
- `/export` omits UM and smb state: export-diffs never clear
  a UM incident; read the subsystem menus directly.
