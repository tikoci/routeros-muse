---
name: backup-restore-upgrade
description: "Back up before you touch, prove you can restore, then upgrade: export coverage audit, pre-change snapshots, twin /import and binary-load drills, upgrade runs with rollback reads. Use when: any backup/export question, restore or rollback planning, RouterOS upgrades, or proving a box is recoverable before a risky change."
topics: [backup, upgrade]
requires: [twin]
tested: none
---

# `backup-restore-upgrade` skill (audit → snapshot → drill → upgrade) [template v1 draft]

Promoted from two executed twin drills (t28-bur-proof.md: Drill A
`/import` restore on twin1/7.26beta3, Drill B binary save/load
rollback across a reboot on twin4/7.26beta3), the export-path
decision note (export-path.md), and the export-omissions inventory
(t7-export-gaps.md). The UPGRADE RUN itself is prescribed, not
executed — no package upgrade ran on any box in this grounding; the
rollback reads around it are the proven parts. Build-tracker
references (T/K IDs, notes paths) are pointers pending staging
scrub. No secrets below.

## Part 1 — The checklist (recoverable before risky)

Run top to bottom. No risky change (upgrade, netinstall, bulk
rewrite) touches a non-twin box before steps 1–3 are recorded.

1. Audit coverage: list what `/export` OMITS on this box (UM state,
   dude DB, cert bodies, file contents — step 0) and capture each
   omitted class by its own read. An export alone is not a backup.
2. Snapshot before the change: full `/export` to text (off-box) AND
   `/system/backup/save` to a named `.backup` (on-box + downloaded).
   Record both artifacts in the ledger with sizes and hashes.
3. Drill the restore on a twin: `/import` the text export onto a
   twin and read back; binary-load the `.backup` on a (disposable)
   twin and read back across the reboot. Un-drilled restores are wishes.
4. Upgrade (prescribed): `check-for-updates` (write-gated) →
   record installed vs latest → snapshot (step 2) → upgrade →
   post-upgrade read-back of identity, packages, and the menus the
   change touches → rollback on mismatch (step 5).
5. Verify + ledger: post-change reads match the pre-change
   snapshot modulo intent; artifacts retained per the box's
   retention; rollback path named (import file, backup file, or
   netinstall per #12).

### 0. What /export omits (the coverage audit)

Grounded: t7-export-gaps.md:39-57 — observed on real 7.26beta3
captures (bigdude 285-line export + twin1 minimal export):

- user-manager state: OMITTED (zero lines; on UM-wedged boxes the
  export instead emits 10 `#error exporting "/user-manager*"` lines
  — t7:82-86). UM coverage comes from `/user-manager/*` reads, not export.
- dude database: only a `set data-directory` pointer line; no
  devices/history/maps. Export is not a dude backup.
- certificates: settings + refs only; no bodies, no keys.
- file contents: `/file` absent entirely; no file bytes anywhere.
- secrets: redacted by design (structure kept, values stripped) —
  a restore from a redacted export does NOT restore secrets.
- hardware/volatile: serial/system-id in header only; full
  identity comes from `/system/routerboard` (hardware) or
  `/system/license` (CHR) reads.

Coverage rule: for each omitted class the box actually uses, add
its dedicated read to the snapshot (UM menus, `/file/print`,
certificate inventory). The pull/ prototype's 4-JSON-menus shape
is the standing pattern (t7:21-26).

### 1. Text export (read — the portable snapshot)

```sh
centrs execute --quickchr <twin> '/export'
# -> {"ret": "<full text>"} — read-shaped, no --yes needed
```

- Grounded: export-path.md:9-23 — direct `/export` over native API
  is read-shaped (no `file=`), no `--yes` gate, output returned not
  backgrounded. Full export re-observed this session
  (t28-bur-proof.md Drill A).
- Menu-scoped quirk (new): bare `/ip/firewall/address-list/export`
  returns `{}` (EMPTY); the same menu with `export verbose`
  returns full text. Do not trust a bare menu export that comes
  back empty — retry verbose or take the full `/export`
  (t28-bur-proof.md Drill A).
- `show-sensitive=yes` is one word from the safe default and dumps
  secrets into the output (centrs#359). Never use it for snapshots;
  targeted reads over broad dumps, always.
- Snapshot hygiene: store off-box, redact before retention
  (`password|secret|private-key|community` + inline `env="K=V"` —
  same rules as change-apply Recovery), record size + hash.

### 2. Binary backup (write — the full-fidelity snapshot)

```sh
centrs execute --quickchr <twin> '/system/backup/save name=<snap-name>' --yes --timeout 30s
centrs execute --quickchr <twin> '/file/print'   # confirm <snap-name>.backup present
centrs transfer --quickchr <twin> download <snap-name>.backup ./<snap-name>.backup
```

- Grounded: save ran twice this session (twin1 `t28-pre-drill`,
  twin4 `t28-load-drill`); both `.backup` files confirmed via
  `/file/print` (t28-bur-proof.md Drills A/B).
- Binary backups are arch- and version-sensitive: a CHR/x86
  `.backup` is not a restore path for ARM hardware. The text
  export is the portable half; the binary is the
  same-box-rollback half. Keep both, label which is which.
- Download the `.backup` off-box: an on-box-only backup dies
  with the disk it backs up. `transfer download` is the move
  (small files ride REST fine).

### 3. Restore drill A — /import (write — twin, no reboot)

```sh
# .rsc written locally (compact export form), uploaded, imported:
printf '/ip firewall address-list\nadd address=... list=...\n' > /tmp/restore.rsc
centrs transfer --quickchr <twin> upload /tmp/restore.rsc restore.rsc
# -> upload ok method=rest ... verified=size
centrs execute --quickchr <twin> '/import file=restore.rsc' --yes
# -> {"ret": "Script file loaded and executed successfully"}
centrs execute --quickchr <twin> '/ip/firewall/address-list/print'  # read back: entries + comments intact
```

- Grounded end to end (t28-bur-proof.md Drill A): two entries
  created, exported, destroyed (print back to `{}`), restored
  from the uploaded .rsc with comments intact, then removed with
  the .rsc for a pristine finish.
- Restore-file idiom: menu header line (`/ip firewall
  address-list`) + compact `add` lines, exactly the full-`/export`
  shape. The verbose form (`disabled=no dynamic=no`, backslash
  continuations) also exports but the compact form is the cleaner
  restore source (routeros-scripting: stable selectors over IDs;
  no `dynamic=` guessing needed).
- Upload carries the file: `transfer upload` auto-selects REST
  for small files (`verified=size` in the output). RouterOS
  `/file` contents caps at 60 KB over REST/native-API — larger
  restores auto-hop to SFTP, which needs key auth on the box.

### 4. Restore drill B — binary load (write — DISPOSABLE twin, reboots)

```sh
centrs execute --quickchr <twin> '/system/backup/load name=<snap-name> password=""' --yes --timeout 30s
# -> {} (accepted; reboot follows async — poll, do not assume)
centrs execute --quickchr <twin> '/system/identity/print'   # poll until it answers
# -> {"name": "<pre-change marker>"} — rolled back across the reboot
```

- Grounded end to end (t28-bur-proof.md Drill B): identity
  `CHR` → `twin4-drill` → backup → `twin4-changed` → load →
  reboot (uptime 11s) → identity back to `twin4-drill` on the
  first poll. Marker restored, baseline (`CHR`) then re-set.
- `password=` is REQUIRED even when the backup has no password:
  bare `load` fails with `[routeros/api-trap] missing =password=`.
  Pass `password=""` explicitly.
- Reboot is async: the `{}` accept is not the completion. Poll a
  cheap read (`/system/identity/print`) against a wall-clock
  deadline; confirm the rollback by the marker read, not by the
  accept. Uptime reset corroborates.
- Run this ONLY on a disposable twin: load reboots the box and
  restores users/credentials to snapshot time. twin1/twin2 are
  never deleted — a dirty-work twin (twin4 here) takes the
  reboot, then gets its baseline restored.

### 5. Upgrade run (PRESCRIBED — no package upgrade executed)

```sh
centrs execute --quickchr <twin> '/system/package/update/check-for-updates' --yes --timeout 60s
# NOTE: write-gated despite being a check; returns channel/installed-version/status rows
```

- Grounded half: `check-for-updates` without `--yes` is refused
  (`usage/confirmation-required`); with `--yes` it returns status
  rows including `installed-version` (t28-bur-proof.md). The
  actual upgrade (`/system/package/update/install`, reboot,
  post-read-back) has NOT run anywhere — procedure below is
  prescribed from the drill mechanics, honestly marked.
- Prescribed order: check → record installed-vs-latest →
  snapshot (steps 1–2) → twin-first: run the SAME upgrade on a
  twin at the same version first (swarm: twin-first-routeros-
  upgrade) → production upgrade → post-upgrade read-back
  (identity, `/system/package/print`, touched menus) against the
  snapshot → mismatch means rollback (binary load per step 4, or
  netinstall per #12/T17 on hardware).
- Rollback reads are the proven parts (steps 3–4); the install
  step itself is the unexecuted half. Say so in the ledger.

## Part 2 — Skill doc

### Trigger

Load when: any backup/export question; restore or rollback
planning; a RouterOS upgrade is proposed; proving a box is
recoverable before a risky change; coverage questions ("is the
export enough?" — it is not, see step 0).

### Prereqs

- centrs on PATH; target reachable (`first-contact` first on any
  box not yet in the device registry).
- A twin at matching firmware for the drills (`quickchr list`
  shows it running); a DISPOSABLE twin for binary-load (step 4).
- The box's actual state inventoried: which omitted classes (UM?
  dude? certs? files?) apply, so the audit (step 0) is concrete.

### Access

- Twins: anything goes; Drill B takes a disposable twin, never
  shared infra at a bad time.
- bigdude (production): reads free; ANY write asks the developer
  first — including `/system/backup/save` (a filesystem write)
  and especially `load` (reboot + credential rollback).
- Operator Unknown → ask before any write (concepts K14).

### Envs

| Name | Use |
|---|---|
| `CENTRS_TIMEOUT` | Default 10s; save/load/check need `--timeout 30s`–60s |
| `CENTRS_USERNAME` / `CENTRS_PASSWORD` | CLI fallback auth for `--host` targets |
| `CENTRS_SSH_KEY` | Batch SSH key path (large-file SFTP hop) |

### Outputs

- Coverage audit: omitted classes present on this box + their
  dedicated reads.
- Snapshot record: export text (off-box path + hash) and
  `.backup` (on-box name + downloaded path + hash).
- Drill record: twin + date + commands + read-back evidence for
  the import drill and (if run) the load drill.
- Upgrade record (prescribed): installed-vs-latest, twin-first
  result, post-upgrade read-back, rollback path named.

### Verification

- Menu read-back after import matches the pre-destroy export
  modulo intent (comments, addresses, lists).
- Identity marker after binary load matches the snapshot-time
  value; uptime confirms the reboot happened.
- Post-upgrade package + identity + touched-menu reads match
  the snapshot modulo the intended version bump.
- Box left clean: drill artifacts (scratch entries, .rsc,
  drill `.backup` files) removed; baselines restored.

### Recovery

- Bare menu export returns `{}` → retry with `export verbose`
  or take the full `/export`; empty is a quirk, not proof of
  empty config (step 1).
- `missing =password=` on load → add `password=""` (step 4).
- `usage/confirmation-required` on check-for-updates → it is
  write-shaped; add `--yes` (step 5).
- Import reports success but read-back mismatches → STOP; the
  box state is unknown. Re-read, compare, escalate with
  expected vs observed. Do not clean up blind.
- Wedged state on a twin → rebuild the disposable twin; on
  production → escalate with the full run record.

### Limits

- The package-upgrade install step is PRESCRIBED, never
  executed — the first real upgrade run must go twin-first and
  the skill updated with its evidence.
- Binary `.backup` is same-arch/same-version rollback only;
  cross-box or cross-arch restore is the text export's job,
  minus secrets (redacted by design).
- Export omissions (step 0) are observed on 7.26beta3 (+7.25
  UM row); other versions need their own audit capture.
- Netinstall fallback is #12's procedure (T17 window,
  external); this skill names it, does not contain it.
