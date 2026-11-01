---
name: usermanager-ops
description: "User Manager admin inside its proven failure bounds: db-path depth rule, wedge signature and escape, setup recipe, post-reboot verify. Use when: UM setup, user adds, db-path questions, UM wedge symptoms, or post-reboot UM checks."
topics: [usermanager, diagnosis]
tested: none
---

# `usermanager-ops` skill (bounds → setup → operate → verify) [template v1 draft]

Promoted from the executed UM bisection campaign (a twin
depth/disk matrix on 7.26beta3 + a C2 repeat on 7.25: failure axis
named, wedge fully characterized, setup recipe proven). The OPS
playbook is new; every bound below ran on twins. No secrets below;
never paste user passwords into notes.

## Part 1 — The checklist (stay inside the bounds)

Run top to bottom. The depth rule (step 1) is load-bearing: violating
it wedges UM beyond in-place recovery on every tested version.

1. Learn the failure bounds cold: second disk AND ≥2 levels below
   the mount FAILs after reboot (7.24.5/7.25/7.26beta3); depth-1 or
   boot disk PASSes; depth-0 is rejected at set.
2. Set up UM the proven way: format with `numbers=`, depth-1-or-boot
   db-path, enable, add users with `name=/password=` params.
3. Operate inside the bounds: reads free, adds by recipe, never move
   db-path deeper; `/export` omits UM — read subsystem menus directly.
4. Verify after EVERY reboot: the db-size/users/log triple must show
   healthy, or you are wedged and must not proceed to other work.
5. Escape a wedge only via fresh-dir db-path (the ONLY recovery);
   every other rung was proven dead on twins.

### 0. The failure bounds (memorize this box)

| db-path shape | Example | Post-reboot verdict |
|---|---|---|
| 2nd disk, depth 1 | `/pcie1/b1` | PASS (S1: user intact, no errors) |
| 2nd disk, depth ≥2 | `/pcie1/bisect-ws/user-manager`, `/pcie1/c1/c2` | FAIL (S2, C2: wedge) |
| Boot disk, 2–3 comps | `/bb1sub/bb2`, `/bc1/bc2/bc3` | PASS (B2, B3) |
| Depth 0 (either disk) | `/pcie1`, `/` | REJECTED at set (never usable) |

- Grounded: the twin bisection matrix; verdict "second
  disk AND ≥2 directory levels below the mount point".
  Not pure depth (B3 survives), not
  names (fresh c1/c2 reproduces), not a race (persists 25+ min).
- Versions: fails on 7.24.5, 7.25, and 7.26beta3; a second twin
  proved the C2 FAIL byte-identical on 7.25.
- Depth-0 rejection: "Directory needs to be empty OR have a valid
  userman-5 database" — mount roots always hold `lost+found`, so
  depth-0 can never satisfy it.
- Wedge signature (all five together): db-size 0, free-disk-space 0,
  user list empty, log shows "Database disk not yet usable. Please
  wait.", disk MOUNTED with sqlite files INTACT.
  Mounted-disk + intact-files + unusable-DB = wedge.

### 1. Setup (the proven recipe)

```sh
quickchr add --name <twin> --version <ver> --add-package user-manager --add-disk 512M
quickchr start <twin>
quickchr exec <twin> "/disk/format numbers=0 file-system=ext4"
quickchr exec <twin> "/file/add name=pcie1/um type=directory"        # depth 1!
quickchr exec <twin> "/user-manager/database/set db-path=/pcie1/um"
quickchr exec <twin> "/user-manager/database/print"                 # 148.6KiB healthy
quickchr exec <twin> "/user-manager/set enabled=yes"
quickchr exec <twin> "/user-manager/user/add name=<u> password=<p>"
quickchr exec <twin> "/user-manager/user/print"                     # user visible
```

- Grounded end to end on a twin (build → format → dirs →
  db-path → enable → add → verify, pre-reboot HEALTHY 148.6KiB).
- `/disk/format numbers=` is the form — `/disk/format-drive` does
  NOT exist on 7.26beta3; `numbers=` also works on 7.25.
- User params are `name=/password=` — there is NO
  `/user-manager/customer` menu on this build and NO `login=` param.
- Healthy baseline signature: db-size 148.6KiB, um5.sqlite 48.0KiB +
  um5.sqlite-wal 100.6KiB. Record yours; it is
  the comparison point for every later check.
- On production this whole recipe rides `change-apply` (propose →
  stage → run → read back). The twin run above IS the proof step.

### 2. Operate (reads, adds, and the never-list)

- Reads are free and safe: `/user-manager/database/print`,
  `/user-manager/user/print`, `/log/print where message~"Database"`.
- Adds follow the recipe (`name=/password=`); new users show
  `group=default` — the default-group shape is the REVIEWER beat:
  know which group your RADIUS/Wi-Fi-AAA path actually
  authorizes before trusting a default-group user in production.
- `/export` OMITS UM (and smb) state: export-diffs never
  describe UM — read `/user-manager/*` menus directly, and capture
  UM state via JSON-menu reads in your pull set.
- NEVER: db-path at depth ≥2 on a second disk; db-path at a mount
  root; "reboot to see if UM comes back" without a fresh capture
  first (`incident-response` step 1).
- NEVER move a healthy db-path without a verified fresh-dir target
  and a rollback read: db-path moves are writes with wedge risk.

### 3. Post-reboot verify (mandatory, every reboot)

```sh
quickchr exec <twin> "/user-manager/database/print"   # db-size nonzero?
quickchr exec <twin> "/user-manager/user/print"        # users visible?
quickchr exec <twin> "/log/print where message~\"Database\""  # no errors?
```

- The triple must show healthy (db-size ≈ baseline, users listed,
  no Database errors) or the box is WEDGED — stop other work.
- Confirm the reboot actually happened first: uptime ~50s AND
  write-sect-since-reboot reset (the two-signal rule from
  `incident-response`); a stale boot voids the check.
- Persistence re-check minutes later: the wedge never self-healed
  in any probe (25+ min, second reboot, +3 min re-checks all still
  failing on twins).
- Healthy S1 pattern to match: db-size 148.6KiB, user row intact,
  zero log matches.

### 4. Wedge escape (fresh dir — the only recovery)

```sh
quickchr exec <twin> "/file/add name=pcie1/<fresh> type=directory"
quickchr exec <twin> "/user-manager/database/set db-path=/pcie1/<fresh>"
quickchr exec <twin> "/user-manager/database/print"   # db-size back immediately
```

- Grounded: Probe C unwedged UM immediately (db-size 148.6KiB,
  free-space back). Everything else failed:
  re-set same path (no recovery), disable/re-enable (the set command
  itself errors — UM fully unmanageable), second reboot (still
  failing).
- The escape abandons the old DB files (they stay on disk, intact
  but unreferenced): users must be re-added. State data loss plainly
  in the incident record — never imply the old users survive.
- After escape: re-add users, re-run the healthy-baseline record,
  reboot-verify once more. Then close via `incident-response` step 5.

## Part 2 — Skill doc

### Trigger

Load when: setting up User Manager; adding/listing UM users;
choosing or moving db-path; UM wedge symptoms (empty users,
"Database disk not yet usable"); post-reboot UM checks; UM + disk
planning. (Entry-skill + capability-probe pattern.)

### Prereqs

- Target reachable (`first-contact` done for new boxes); twins at
  matching firmware for any bound-testing (`quickchr list`).
- user-manager package installed (`/system/package` shows it);
  second disk formatted if db-path leaves the boot disk.
- Healthy-baseline triple recorded for every UM box under care.

### Access

- UM reads free everywhere, production included.
- UM writes (db-path set/move, user add, enable) on production need
  owner approval per `change-apply`; on twins, anything goes.
- Wedge escape on production is a write with data-loss shape
  (old users abandoned): explicit approval + incident record first.
- Never paste user passwords into notes, captures, or handoff notes.

### Envs

| Name | Use |
|---|---|
| `CENTRS_USERNAME` / `CENTRS_PASSWORD` | Host-path auth for UM reads/writes |
| `CENTRS_TIMEOUT` | Raise for slow-box UM reads |

### Outputs

- Setup record: db-path, baseline triple (db-size/files/users).
- Op record: user adds / reads with command + output.
- Post-reboot triple: healthy or wedged verdict.
- Wedge record: signature observed, escape commands, re-added users.
- Incident link when anything failed (`incident-response` packet).

### Verification

- Post-setup: db-size ≈148.6KiB scale, sqlite+wal files present,
  user row visible.
- Post-reboot: triple healthy AND reboot confirmed two-signal.
- Post-escape: db-size back, users re-added AND visible, one more
  reboot-verify passed.
- Claim discipline: every bound cited to its cell (S1/S2/C2/B2/B3).

### Recovery

- Wedged → fresh-dir escape (step 4); nothing else works — do not
  retry dead rungs (re-set, disable/enable, reboot) beyond one
  confirmation each.
- db-path rejected at set ("needs to be empty OR have valid db") →
  the dir is non-empty or a mount root: pick an empty depth-1 dir.
- `/disk/format-drive` unknown → use `/disk/format numbers=`.
- `/user-manager/customer` unknown → params are name=/password=.
- Accidental depth-≥2 db-path set (pre-reboot): move it back to a
  depth-1 fresh dir BEFORE rebooting — the wedge triggers at boot.

### Limits

- Bounds proven on CHR x86 (twins) at 7.24.5/7.25/7.26beta3 —
  hardware (ARM) UM paths are untested; first hardware UM setup is
  a twin-shaped proof run on that hardware, honestly marked.
- Boot-disk PASS cells (B2/B3) ran on CHR boot disk with 67MB free;
  tight-flash hardware (26MB free class) needs its own capacity
  check before trusting boot-disk db-path.
- No 7.25 control cells (S1/B2/B3) exist — the depth×disk
  interaction is fully mapped only on 7.26beta3; 7.25 has the C2
  FAIL alone.
- UM DB backup/restore across paths is unproven: treat db-path
  moves as fresh-DB events until a migration recipe is grounded.
