---
name: load-bearing-router-bench-prep
description: "Take a router to the bench without breaking its site: unbundle load-bearing roles, back up VPN identity, arrange login fallback, budget RAM, re-prove per box. Use when: borrowing a production router for lab/demo work, planning bench capacity, or returning a box to service."
topics: [bench, lab, hardware]
tested: none
---

# `load-bearing-router-bench-prep` skill (unbundle → back up → budget → re-prove) [template v1 draft]

Promoted from the load-bearing journal (homework §4: VPN
controller + cross-site RADIUS roles), the bench-loan probes
(P7/P8), the sizing notes (512 MB budgets, L009/RB5009 roles),
the re-prove-per-box rule (demo-hardware-notes), and the
bench-vs-manage table (feedback §4). Backlog #39. No secrets
below; identities travel as backup-exists, never as values.

## Part 1 — The checklist (the site survives the loan)

Run top to bottom. A bench loan is a planned amputation: the
site keeps working while its router is gone, or the loan
doesn't happen.

1. Name the load-bearing roles (§0): what the box DOES for
   its site today — VPN, RADIUS, dashboard, DHCP, DNS.
2. Unbundle before the loan (§1): VPN identity backed up,
   login fallback arranged, dependents rerouted or paused.
3. Budget the bench box (§2): RAM with the stack running,
   roles per unit, power/console plan.
4. Re-prove on THAT box (§3): probes run against it, not
   against the lab's memory of a different unit.

### 0. Roles (what breaks if it leaves)

The demo router is load-bearing on the real network TODAY
[JOURNALED, homework §4]: besides the dashboard, it's the VPN
controller for its site AND the RADIUS server the OTHER site
uses for human router logins. A reset, a netinstall, or taking
it to the bench has effects beyond its own site.

- Inventory roles per box before ANY loan/reset/netinstall:
  VPN controller/member, RADIUS server/client, dashboard
  host, DHCP/DNS, CMR controller/client, tunnel endpoint,
  Dude server. The list comes from the box's config + the
  site's dependency notes — ask "who points HERE" per
  service, not "what runs here".
- Cross-site roles are the trap: the other site's human
  logins depending on THIS box's RADIUS is invisible from
  this site's dashboard. Check both directions (who I serve
  + who serves me) before the loan.
- Role split across units is normal (demo-hardware-notes):
  beep-vs-container requirements split the RB953 (cold open)
  from the L009 (container story). One box needn't do
  everything — but every role needs an OWNER, on-bench or
  in-service.
- Applicant's call on timing (journal): the owner knows it's
  a test site — what matters is the DEPENDENCY analysis, not
  permission theater. Record the dependency either way.

### 1. Unbundle (backup identity, fallback logins)

P8 probe (homework): "Demo router unbundled from the real
network (VPN identity backed up, other site's login fallback)"
→ pass signal: "A reset of the demo router doesn't affect the
other site" → fallback: "Don't reset it; film Set up on a
bench box." The fallback is a first-class outcome: no
unbundle, no loan — use a different box.

- VPN identity backup FIRST: a reinstall without it gives
  the site a NEW network ID (journal) — the site's VPN
  membership is identity, not config. Back up per the VPN's
  own mechanics (ZeroTier identity files / WireGuard keys /
  BTH account binding — each VPN backs up differently;
  "exported the config" is not necessarily the identity).
  Verify the backup EXISTS + RESTORES (a backup never
  restored is a rumor — test on a spare or state the gap).
- Login fallback for dependents: the other site's humans
  need a working login path while the RADIUS home is gone —
  local accounts (break-glass discipline,
  agent-access-bootstrap), a second RADIUS target, or a
  maintenance window with humans informed. Fallback TESTED
  (a login performed through it) before the loan, not after.
- Reroute or pause the rest: dashboard moves or shows
  stale-with-age (never fake-live), DHCP/DNS secondaries
  take over (or the outage is scheduled + announced),
  tunnels re-home or wait. Each dependent gets one line:
  moved / paused / scheduled-outage — no silent gaps.
- Bench-vs-manage table (feedback §4): on the bench,
  lockout is EXPECTED AND CHEAP (console рядом, reset free);
  remote, lockout is the main risk. The unbundle is what
  converts the loan from "remote risk" to "bench cheap" —
  without it you're doing remote surgery and calling it a
  bench.

### 2. Budget (RAM, roles, power, console)

P7 probe (homework): "Free RAM on the demo router with the
dashboard + cloudflared running" → "Headroom for one more
Bun container" → fallback: "Run centrs on the Mac side, not
the router." Budgets are measured-with-stack-running, not
nameplate.

- RAM: measure FREE with the current stack running BEFORE
  adding containers (homework §4: dashboard + cloudflared +
  centrs service in 512 MB). Sizing opinions (feedback):
  L009/512 MB hosts a THIN bridge/dashboard comfortably —
  NOT an agent harness (that needs the RB5009-class box or
  the Mac; Codex §5 test list before promising
  harness-in-container). No RAM headroom = the work moves
  (Mac-side, bigger box), not "try anyway and OOM".
- Roles per unit (demo-hardware-notes): RB953 fleet (beep +
  industrial look, older silicon fine), L009 ("works even on
  this" proof point, containers proven on two units),
  RB5009 (headroom default), Audience (retail face). Match
  the unit to the job's needs (radios? containers? beep?
  CPU?) — and record WHY this unit (the next session
  shouldn't re-derive the casting).
- Power + console: bench boxes need reachable power
  (managed PoE = remote power-cycle — the voice vignette's
  "reset the PoE port" is one atomic reversible command;
  netinstall skill notes a PoE switch saves button-holding)
  and a console path that ISN'T the network under test
  (serial, or a second link). A bench box whose only access
  is the config being changed is a lockout waiting to
  happen — §1's "cheap on the bench" requires the bench
  to actually have hands.
- Firmware versions recorded per unit (twin-ops:
  build-at-firmware cuts both ways — the bench box's
  version decides which twin proves its changes). Version
  skew across bench units is labeled, never assumed away.

### 3. Re-prove (on THAT box, not its cousin)

The Cloudflare path was proven on the WRONG router for the
demo (homework §4, VERIFIED box identity: arm64/2-core/
512 MB/128 MB flash/7.26beta3 vs the RB1100AHx4 ARM32 the
path was proven on): three of four fixes depend on the
router's own config — origin address the container can
reach, macvlan vs bridge, input-chain accept rule. Rule:

- P0–P9 probes run against THE unit on the bench, not
  against the lab's memory of a different box
  (demo-hardware-notes, verbatim rule). Re-run the path
  sequence day 0–1 on the bench unit (homework: use the
  official arm64 cloudflared image there; the community
  ARM32 build isn't needed).
- Input rules must survive restarts (JOURNALED): a rule
  keyed on the /app internal interface broke when /app
  removed/re-added that bridge on restart, and container
  addresses shift as apps are added — a rule on
  `in-interface-list=!WAN` + port held up. Pick either
  form, but TEST IT ACROSS A CONTAINER RESTART. Rules
  that die on restart are the bench's favorite heisenbug.
- Twin support per unit (feedback bench-vs-manage): the
  twin tests the WHOLE RENDERED config before hardware is
  touched (except radios) — bench twin at the unit's
  firmware (twin-ops). Sticker→device binding + install
  sheet (what goes where, how to tell it worked) are the
  human artifacts; "netinstalled …, first pull" commit
  messages mark the boundary.
- Return to service is a re-prove too: the box comes back
  with its roles RESTORED (VPN identity back, RADIUS
  serving, dependents re-pointed) + a pull proving each
  (§1 in reverse, checked not assumed). A bench box
  returned without its roles is a site outage in a
  trenchcoat.

## Part 2 — Skill doc

### Trigger

Load when: borrowing a production router for lab/demo/bench
work; planning what runs on which bench unit; RAM/headroom
questions; "can we reset this box" questions; returning a
box to service. (Entry-skill + capability-probe pattern: K22.)

### Prereqs

- Role inventory for the candidate box (§0 — both directions).
- Unbundle plan (§1) with named fallback + tester, or the
  explicit fallback decision (different box).
- Bench capacity: power, console-not-on-test-net, twin at
  firmware, install-sheet owner for hands steps.

### Access

- Bench boxes: anything goes once unbundled (reset/netinstall
  normal — that's what the bench is FOR).
- Pre-unbundle the box is PRODUCTION: reads free, writes need
  the developer per item — the loan doesn't start early.
- VPN identities + login secrets: owner custody, backup-exists
  recorded, values never in notes (agent-access-bootstrap).

### Envs

| Name | Use |
|---|---|
| (none) | Bench prep is inventory + backups + probes; no environment. |

### Outputs

- Role inventory (per service: served-by / serves-whom).
- Unbundle record: VPN backup (exists+restores?), login
  fallback (tested?), dependents (moved/paused/scheduled).
- Bench budget: RAM measured, unit casting + why, power/
  console plan, firmware per unit.
- Re-prove transcript (probes on THAT box) + return-to-service
  checklist (roles restored + pulls cited).

### Verification

- P8 pass: a reset of the loaned box provably doesn't affect
  the other site (fallback tested, not theorized).
- P7 pass: RAM headroom measured with stack running covers
  the planned load, or the load moved with a record.
- Probes green on the bench unit (not cited from another
  box's transcript — check the unit field on every cite).
- Return: every §0 role restored + pull-proven; dependents
  re-pointed; the site's dashboard green-for-real.

### Recovery

- Unbundle blocked (no fallback available): take the P8
  fallback — different box, no loan. Forcing the loan is
  how sites break on camera.
- Mid-loan discovery (a role missed in §0): freeze bench
  writes, assess the dependent, either unbundle-late (backup
  + fallback NOW) or return the box early. Missed roles are
  incident notes, not embarrassments.
- Bench box wedged: console + reset (that's the bench
  privilege) — then re-prove from §3, since "wedged" voids
  earlier probe results on that unit.
- Return-blocked (VPN identity won't restore): the site stays
  on its fallback (login path) + the loan extends with a
  record — identity recovery is vendor/manual work, not to
  be rushed at return o'clock.

### Limits

- Journals are demo-fleet-shaped (L009/RB5009/RB953/Audience,
  512 MB budgets, 7.26beta3): other fleets re-measure P7/P8,
  they don't cite these numbers.
- VPN-identity mechanics differ per VPN (ZeroTier files vs
  WireGuard keys vs BTH binding): this skill demands the
  backup + restore-test, it doesn't prescribe the bytes —
  each VPN's procedure lives with its own docs/runbook.
- Twin support excludes radios (twin-ops K23): bench units
  with radio-dependent roles need hardware proof for the
  radio half — the twin covers config, not coverage.
- Opinion halves marked inline (bench-for-a-week Set-up
  beat, sizing judgments): applicant/developer calls, not
  doctrine. The dependency analysis (§0) is the load-bearing
  part either way.
