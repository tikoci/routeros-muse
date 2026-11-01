---
name: twin-ops
description: "Twin lifecycle for proving work: build at matching firmware, snapshot discipline, bisect, non-disturbance, teardown. Use when: needing a CHR to test against, reproducing a failure, proving a change, or cleaning up lab machines."
topics: [lab, testing, twin]
tested: none
---

# `twin-ops` skill (build → prove → restore → teardown) [template v1 draft]

Promoted from daily twin practice: a twin UM build + bisection,
a 7.25 version-axis repeat, /app proving runs, and the
non-disturbance pattern. Used constantly, written down now.
No secrets below; twin names below are roles, not hosts.

## Part 1 — The checklist (disposable boxes, durable discipline)

Run top to bottom. Twins are cattle with ONE exception: the
standing pair — the two long-lived twins — is never deleted.

1. Build (or reuse) a twin at the EXACT firmware + packages of the
   question; verify package + disk before trusting it.
2. Snapshot before destructive steps so any cell is re-runnable;
   name snapshots for the cell they protect.
3. Prove the work: run the procedure, record pre/post state per
   cycle, confirm triggers with two signals.
4. Respect other sessions' machines: list PIDs at start and end,
   touch only your own boxes, restore prior running state.
5. Tear down what you built (or stop it): remove dirty-work boxes,
   never the standing pair, leave the bench as found plus your record.

### 0. Build (match the question exactly)

```sh
quickchr add --name <twin-n> --version <ver> --add-package <pkg> --add-disk 512M
quickchr start <twin-n>     # packages apply on first start (fetches npk zip)
centrs retrieve --quickchr <twin-n> /system/package   # verify pkg present
quickchr exec <twin-n> "/disk/print"                  # verify 2nd disk present
```

- Grounded: one twin built 7.26beta3 + user-manager + 512M exactly
  this way; a second twin repeated it for 7.25 reusing the
  cached `chr-7.25.img`.
- Fresh CHR ships routeros-only: packages come from `--add-package`
  at add (proven by a twin built without it).
- Container-shaped twins need provisioning AT ADD: `--add-disk 2G
  --add-package container --device-mode-enable container`, then
  first boot verifies `mode=rose container=yes`.
  Container mode cannot be bolted on later
  without a set + reboot cycle — build it in.
- Cached images skip downloads (`Using cached image: chr-7.25`);
  only the package zip fetches at first start. No cache + no
  network = blocked, say so honestly.
- Shape: 1 vCPU / 512 MB / user NIC is the proven default; ports
  auto-assign (http:91xx … winbox:91xx5). Record yours.

### 1. Snapshot discipline (re-runnable cells)

```sh
quickchr snapshot <twin> save <cell-name>   # before the destructive step
quickchr snapshot <twin> list               # what protection exists
quickchr snapshot <twin> load <cell-name>   # machine must be running
```

- Shape verified from `quickchr snapshot --help` (help-verified, not
  run-verified — first user records the run): save
  auto-names ISO-date when omitted; load/delete need the machine
  running; needs qcow2 boot disk. Alias: `quickchr snap`.
- Snapshot BEFORE the trigger (reboot-to-wedge, db-path move,
  package op), not after: a post-failure snapshot preserves nothing
  useful.
- Name for the cell (`pre-c2-reboot`, `healthy-s1`): snapshot names
  are the twin half of the incident results table.
- Snapshots cover the qcow2 BOOT disk: second-disk (pcie1) state is
  NOT in the snapshot — record disk-side state separately (file
  listings + db triples) or rebuild it by recipe.

### 2. Prove (cycles, not vibes)

- One procedure per cycle: configure → record pre-state → trigger →
  confirm trigger (TWO signals: uptime ~50s AND write-sect reset) →
  record post-state. The UM campaign ran 6 cycles unchanged.
- Reboot trigger shape: `quickchr exec <twin> "/system/reboot"` →
  expected `EXEC_FAILED ... "interrupted"` as the connection drops,
  then `sleep 55`.
- Twin-proof states its limits every time: no radios on CHR,
  x86-only packages, CHR lacks `/system/routerboard` (identity via
  license system-id). A twin pass never claims radio/hardware truth.
- Claim = command + output: every cycle row carries the exact
  commands and their outputs, or it did not happen.

### 3. Non-disturbance (shared-bench manners)

```sh
quickchr list   # session START: record names + PIDs + running state
# ... touch ONLY your own boxes ...
quickchr list   # session END: same PIDs, prior running state restored
```

- Grounded pattern: one session ran zero exec/start/stop/clean/
  remove against other sessions' twins all session — host-side `list`
  only — and closed with PIDs unchanged.
- NEVER delete the standing pair: they are the long-lived twins
  (one may carry a wedge as a living specimen — reproduce around
  it). Make your own dirty-work box for destructive probes.
- Restore prior running state at session end: twins you found
  stopped get stopped (`quickchr shutdown` graceful, `stop` for
  power-cut); twins you found running stay running (prior proving
  runs ended stopped-at-prior-state).
- `shutdown <name>` requests /system/shutdown over REST with bounded
  hard-stop fallback (default 10s); `stop` is immediate power-cut
  (help-verified). Prefer shutdown; use stop for wedged guests.

### 4. Teardown (leave the bench as found)

```sh
quickchr shutdown <twin>            # graceful; preserves disks + creds
quickchr remove <twin>              # stops if running, deletes disk + state
quickchr clean <twin>               # reset disk to fresh image (keeps the device)
```

- Shapes from `quickchr stop/shutdown/remove --help` (help-verified):
  remove deletes disk AND state; clean resets the disk but keeps the
  device; all accept `--all` — never use `--all` on a shared
  host (it would take other sessions' twins).
- Remove YOUR dirty-work boxes when the work closes; stop (not
  remove) any box another session might reuse, and announce it in
  the shared notes.
- Deleting a twin with unrecorded state destroys evidence: the run
  record (notes + a shared post) lands BEFORE the remove.
- The standing pair is never a remove/clean target. No exceptions, no
  "just this once" — rebuild your own instead.

## Part 2 — Skill doc

### Trigger

Load when: needing a CHR to test against; reproducing a failure;
proving a change before production; version-axis questions; lab
cleanup; "which twin / what state" questions. (Entry-skill +
capability-probe pattern.)

### Prereqs

- quickchr + centrs on PATH; KVM available (`quickchr doctor` all
  green).
- Disk for images (~130MB base + packages + disks per twin);
  cached `chr-<ver>.img` or network to fetch.
- The question written down: firmware + packages + disk shape the
  twin must match. No question = no build.

### Access

- Lab host is yours to build on; other sessions' RUNNING twins are
  read-only curiosities — never exec/start/stop/remove them.
- The standing pair: never delete, never clean; a kept wedge is a
  specimen — reproduce around it, don't "fix" it without asking.
- Production contact from twin work is forbidden: no
  production-address traffic in a twin session.

### Envs

| Name | Use |
|---|---|
| `QUICKCHR_SHUTDOWN_TIMEOUT` | Overrides default 10s shutdown wait |
| `CENTRS_TIMEOUT` | Raise for slow-twin reads |

### Outputs

- Build record: name, version, packages, disk shape, ports.
- Cycle records: pre-state, trigger, two-signal confirm, post-state.
- Snapshot list: name → protected cell.
- Session-end list: PIDs unchanged, prior running state restored.
- Teardown record: what was removed/stopped and why.

### Verification

- Post-build: package listed + disk visible before first use.
- Post-cycle: trigger confirmed two-signal, or the cycle is void.
- Session-end `quickchr list` matches session-start (names + PIDs)
  except your own deliberate builds/removes.
- Claim discipline: every twin result states CHR limits.

### Recovery

- Build fails on package fetch → check cache (`quickchr cache
  list`) and network; retry once, then report blocked.
- Twin won't start → `quickchr logs <name>` + `doctor`; port clash
  means another session owns those ports — pick another device,
  never remove the clash.
- Post-trigger state ambiguous (uptime high?) → trigger didn't fire:
  void the cycle, re-fire, do not record.
- Wedged guest ignoring shutdown → `stop` (power-cut), note the
  unclean stop; pending guest changes may be lost (help-verified).

### Limits

- CHR ≠ hardware: no radios, no RouterBOARD menus, x86 packages
  only, timing differs (55s boot waits are CHR-shaped). Hardware
  proof needs hardware or explicit owner-accepted risk.
- Snapshot/load/delete shapes are help-verified, not run-verified
  in our notes: first user runs one save/load round-trip on a
  disposable twin and records it.
- Second-disk state is outside qcow2 boot snapshots: disk-side
  cells rebuild by recipe, not by snapshot load.
- Sourced 2026-10-29 (homework §13 journal, via cmr-fleet-guard):
  sanitize VPN/CMR-controller-addresses/tokens before booting a
  twin from production-derived state — a twin VPN-join test really
  joined the production VPN and left a member behind; a CMR
  controller address or TUNNEL_TOKEN in the export joins the real
  fleet/tunnel the same way. Journaled, not re-run here.
