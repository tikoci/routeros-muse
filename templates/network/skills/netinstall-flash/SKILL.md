---
name: netinstall-flash
description: "Reflash a MikroTik device to a known-good state: RouterOS netinstall package-flow server entries plus netinstall-cli runs, window planning, and first-pull close. Use when: provisioning from bare metal, recovering a wedged box, or scheduling a bench flash window."
topics: [netinstall, provisioning, netinstall-package]
tested: self-test
---

# `netinstall-flash` skill (model → render → validate → window → first pull)

This skill PLANS and WINDOWS a flash; the
etherboot + cable + button half is hands work, and the
RouterOS domain half (flags, scripts, boot order) lives in
the `routeros-netinstall` domain skill — consumed here,
never redefined. Two models, one validator:

- PRIMARY: the RouterOS netinstall PACKAGE flow — a
  `/tool/netinstall` server entry on a bench/hardware
  router, driven over centrs. Observed live (read-only,
  production hardware/7.26beta3, 2026-10-31): two server rows with
  interface/version/extra-packages/mode-file/keep-old/
  apply-default/install-once/remove-branding/auto-reboot
  fields; one row invalid with `.about: Can not run on
  slave interface`. No secrets below — field names only.
- SECONDARY: `netinstall-cli` from a Linux host against
  an etherboot target (collected: routeros-netinstall
  skill + tikoci/netinstall wrapper as reference).

No twin: CHR carries no netinstall server (observed:
a 7.26beta3 CHR exposes no `/tool/netinstall` path and
ships only the `routeros` package) and cannot etherboot
as a target. The bench proves a flash, never a twin.
No executed flash exists yet — the production
window is developer-scheduled (external), and
the package-flow shape of a prior test deployment cited in the backlog
has no in-repo artifact. Until the first window runs,
every plan below is validated-on-paper, stated as such.

## Part 1 — The checklist (a flash is a window, not a command)

Run top to bottom. Steps 1–3 touch nothing; step 4 is
the window; step 5 closes it into the records.

1. Pick the model: package-flow server entry (a RouterOS
   box serves) or cli run (a Linux host serves) (step 0).
2. Render the plan from the repo template: image set,
   scripts, target MAC, window fields (step 1).
3. Validate mechanically: the reference checker must
   accept the plan before the window schedules (step 2).
4. Run the window: hands on the bench, agent on the
   server/host read-back (step 3).
5. First pull + close: the flashed box is unknown until
   pulled; commit marks the boundary (step 4).

### 0. Pick the model (the only branch)

- Package flow when a RouterOS box can face the target
  over L2: one `/tool/netinstall` server entry per
  segment (interface, pinned version, extra packages,
  mode file, keep/apply choice). The agent tells the
  hands which port to plug into; a PoE switch saves
  button-holding; the repo holds the config template.
  Observed constraint: the entry interface must NOT be
  a slave (bond/bridge member) — the box refuses with
  the `.about` shape quoted above.
- CLI run when no serving box exists: `netinstall-cli`
  on Linux, root, static IP, target in etherboot, MAC
  pinned via `--mac` from the label photo. Host rules
  (collected): x86_64 runs direct; ARM needs
  `qemu-i386` (i386 ELF); macOS needs a bridged Linux
  VM. Static IP on the host is strongly recommended.
- Keep-old (`-r`-less/`-e`-less, or keep-old true) is a
  config-DB carry, NOT a backup: user files, Dude and
  User Manager databases do not survive. Say so in the
  plan or pick empty/default.

### 1. Render (template → plan, MAC from the photo)

- Start from the repo config template (render/stage:
  `render` turns a device into a
  full script with secrets as placeholders; `stage`
  uploads; the harness asks the human first). Secrets
  enter only the uploaded copy, never the repo plan.
- Plan JSON follows the reference fixtures
  (`references/fixtures/good-cli.json`,
  `good-server.json`): kind, image set with the system
  package FIRST (x86 is the naming exception —
  `routeros-VERSION.npk` carries no arch infix),
  exactly one config mode (default/empty/keep),
  modescript vs configure script split, target arch +
  MAC + etherboot method, window fields.
- Script split (hard rule, validator-enforced):
  `/system/device-mode` changes go ONLY in the
  modescript (`-sm` / mode-file; runs first, 7.22+,
  auto-removed, reboots immediately after a device-mode
  change). The configure script (`-s`) replaces the
  default-configuration stage and persists across
  later resets — never put one-shot state in it.
- Multi-arch image sets are allowed; the target arch
  must be present in the set. DHCP must be absent from
  the flash segment (BOOTP/DHCP ports; trust the
  netinstall-facing port if snooping is on).

### 2. Validate (mechanical gate before scheduling)

- Run `references/validate-plan.py <plan.json>`: R1
  system-first, R2 config-mode stated (+ keep
  acknowledged), R3 script split (+ 7.22 floor), R4
  target arch present, R5 root + static IP, R6 host
  rule, R7 MAC + etherboot + window fields, R8 server
  entry shape (no slave, version pinned, no
  keep+default contradiction). Observed (self-test):
  2/2 good fixtures pass, 5/5 broken fixtures fail
  naming their rule.
- A rejected plan does not schedule. Fix the plan,
  never hand-wave the rule — every rule is a past
  failure shape (slave-interface and keep-loses-files
  are observed; the rest are documented).
- Validation is on-paper until the first window runs: it proves
  the plan is well-formed, not that the target will
  etherboot. The window report records which half
  the validation covered.

### 3. Window (hands + read-back)

- The window is developer-scheduled (backup
  exists, non-critical). Window fields: bench
  location, L2 segment, etherboot method, target MAC,
  serving side (package entry or cli host), config
  template ref, rollback (re-flash with prior image
  set), hands contact, stop conditions.
- During: hands holds the button / watches LEDs; the
  agent reads back the serving side (package-flow:
  server row state; cli: verbose log) — never trust
  the return, per `deployment-readback-verification`.
- Stop conditions (any one stops the window):
  target never appears in etherboot; wrong MAC
  answers; install errors mid-transfer; first boot
  does not come up in the agreed time. Record what
  was observed, not what was hoped.
- The flashed box gets NO traffic until step 4: an
  unproven flash is not a router, it is a bench
  occupant.

### 4. Close (first pull marks the boundary)

- First pull per `state-pull` + `unbox-provision` §4:
  redacted export + stripped JSON + manifest, checker
  clean. The pull is the flash's proof of life.
- Commit message marks the boundary (collected:
  the review feedback): "netinstalled …, first pull".
  Device/label/serial binding follows unbox-provision's rule
  (system-id + license-id + sticker photo).
- File the window report next to the plan: window
  time, hands, image set served, etherboot method
  used, deviations, pull result. Deviations update
  THIS skill (procedure) or the domain skill
  (RouterOS behavior) — never just the report.

## Part 2 — Skill doc

### Trigger

Load when: flashing or reflashing a device; planning a
bench window; recovering a box that no longer boots
clean; serving images from a RouterOS box; or answering
"how do we get RouterOS onto this unit".

### Prereqs

- The flash backlog item + window state read.
- `routeros-netinstall` domain skill available (flags,
  script order, etherboot notes — this skill does not
  restate them past the validator's needs).
- Repo config template for the target device; target
  MAC from the label photo; python3 for the checker.
- A scheduled window with hands for step 3; steps
  1–2 need no window.

### Access

- Steps 1–2 are local planning: safe anywhere,
  including beside production. No twin, no box
  writes — CHR cannot serve or receive netinstall.
- Step 3 touches the bench segment only (L2
  flashing, no production path). Package-flow reads
  of the serving box are read-only centrs retrieves.
- Step 4 pulls the flashed box (read-only capture).

### Envs

No environment this skill consumes. Serving-side
credentials (if the package entry lives on a managed
box) come from the CDB per `first-contact`, never
from this skill's artifacts.

### Outputs

- Flash plan (validated JSON: kind, image set,
  scripts, target, window fields).
- Window report (time, hands, deviations, result).
- First pull + boundary commit (the flash's proof).
- Skill deltas when the bench disagrees (filed, not
  just noted).

### Verification

- Validator accepts the plan (exit 0) before the
  window schedules; every rejection names its rule.
- Serving-side read-back during the window (row
  state or verbose log), not just the exit code.
- First pull checker-clean after the flash; commit
  message carries the "netinstalled …, first pull"
  boundary.
- Window report exists next to the plan with
  deviations or an explicit none.

### Recovery

- Plan rejected → fix the named rule; do not edit
  the validator to pass a bad plan.
- Target never etherboots → check L2 path (USB
  adapters flap; snooping blocks; wrong port),
  re-try inside the window, else reschedule.
- Wrong MAC answers → STOP: re-verify the label
  photo before any further serve.
- Flash succeeds but first pull fails → the box
  stays a bench occupant; diagnose per
  `incident-response`, do not route traffic.

### Limits

- No executed flash yet: validator + shapes are
  proven on fixtures and read-only probes; the
  first window is the skill's real proof.
- The package-flow precedent of a prior test deployment is cited
  from the backlog without an in-repo artifact —
  collected, not observed. First window ratifies.
- This skill plans and windows; it never redefines
  RouterOS netinstall behavior (domain skill owns
  that) and never provisions past first pull
  (unbox-provision owns from the pull forward).
- CHR cannot prove any of this — do not burn twin
  hours trying; the bench is the testbed.
