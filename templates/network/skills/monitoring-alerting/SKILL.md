---
name: monitoring-alerting
description: "Watch the boxes and speak only on change: what to read, netwatch up/down/recovery probes, threshold checks, notify-on-change discipline. Use when: setting up monitoring for a router or fleet, adding a netwatch probe, choosing thresholds, wiring notifications, or asking what healthy looks like."
topics: [monitoring]
requires: [twin]
tested: none
---

# `monitoring-alerting` skill (reads → probes → thresholds → notify-on-change) [template v1 draft]

Promoted from the executed netwatch flap drill
(t28-hsmon-proof.md, twin1/7.26beta3: up + down + recovery
scripts all fired and logged) plus the K20 look-after chain
(concepts.toml K20: collect/investigate/notify cadences,
hysteresis, dedup, recovery announce, failed-never-green).
The SCHEDULED LOOP (T12) and the notify TRANSPORTS (mail,
webhook, push) are prescribed, not executed — what IS proven
is the on-box probe mechanics and the read inventory. Complements
#3 look-after-ops (the loop procedure when T12 lands) and #38
service-path-fleet-check (the fleet view); this skill is the
single-box watch. Build-tracker references (T/K IDs, notes
paths) are pointers pending staging scrub. No secrets below.

## Part 1 — The checklist (prove the probe before trusting it)

Run top to bottom. No alert the owner sees should rest on a
probe that never fired on a twin.

1. Inventory the reads: confirm which watch-menus answer on
   THIS box (resource, logs, netwatch, packages — step 0).
   CHR lacks sensors; hardware lacks nothing but costs flash.
2. Stage the probe on a twin: netwatch host + up/down log
   scripts, short interval AND short startup-delay (step 1).
3. Fire all three transitions: down (unreachable host), up
   (gateway), recovery (flip dead→live). All three must log
   before the probe shape is trusted (step 2).
4. Set thresholds with hysteresis: alert value, clear value,
   and the dedup window — never a single trip line (step 3).
5. Wire notify-on-change only: collection runs often,
   investigation on state change, notification on
   transitions + recovery. Steady-state is silent (step 4).

### 0. What to watch (the read inventory)

Grounded reads (all ran on twin1 this session unless noted):

- `/system/resource/print` — uptime, load, free-memory,
  free-hdd-space. The liveness heartbeat; poll it first,
  always. (Observed on every twin readiness check.)
- `/log/print [where ...]` — the box's own event stream.
  Probe scripts land here (`script,info` /
  `script,warning`); config changes self-log
  (`Netwatch config added by api:...` observed). Logs are
  append-only: drill lines persist, which is evidence, not dirt.
- `/tool/netwatch/print` — probe states (`up`/`down`/
  `unknown`) + the `.about` startup-delay warning. Read
  after any netwatch change: `unknown` + the warning means
  "waiting", not "broken".
- `/system/package/print` — installed versions; the drift
  input for upgrade planning (#5).
- `/system/health/print` — hardware sensors. On CHR it
  answers `{"state":"disabled"}` (proven this session):
  no sensors, no data. On hardware this menu is the
  temperature/voltage/fan watch — but confirm it answers
  before building thresholds on it.
- `/interface/print stats` + firewall counters (#8) — the
  traffic half: counters that should move and don't are a
  signal (stuck queue, dead peer).

NOT watched from here: dude DB internals, UM rows, file
bytes — those are pull/ + coverage-audit (#5) territory.

### 1. Netwatch probes (writes — twin first, always)

```sh
centrs execute --quickchr <twin> '/tool/netwatch/add host=10.0.2.2 interval=10s startup-delay=5s up-script=":log info t28-nw-up-gw" down-script=":log warning t28-nw-down-gw" comment="t28-nw-gw"' --yes
# -> {"ret": "*1"}
```

- Grounded end to end (t28-hsmon-proof.md): two hosts added
  (gateway + unrouted), states read back, scripts fired,
  tagged cleanup to `{}`.
- `startup-delay` defaults to 5 MINUTES: fresh probes sit at
  `status: unknown` with a `.about` warning and fire
  nothing until it elapses (observed verbatim). For drills
  set `startup-delay=5s`; for production set it
  deliberately (post-reboot flapping vs time-to-first-
  probe) and record the choice.
- Script bodies stay single-token-log simple:
  `:log info <marker>` / `:log warning <marker>`. No
  quoting gymnastics across the transport; the marker
  carries the meaning (`t28-nw-down-dead` beats a
  sentence). Escalation (mail, webhook) hangs off the
  log/topic layer or the loop — not inside the probe.
- Tag every probe (`comment=`): rollback is
  `remove [find comment~"<tag>"]` + re-print, same as #8.

### 2. Fire all three transitions (writes — the trust step)

```sh
# down:  host=10.255.255.1 (unrouted)  -> status down,  :log warning fires
# up:    host=10.0.2.2 (gateway)        -> status up,    :log info fires
# flap:  set [find comment="<tag>-dead"] host=10.0.2.2  -> up-script fires = RECOVERY
centrs execute --quickchr <twin> '/log/print where message~"<marker>"'  # read back all three
```

- Grounded (t28-hsmon-proof.md): `t28-nw-up-gw` 20:21:28,
  `t28-nw-down-dead` 20:21:31, `t28-nw-up-dead` (recovery)
  20:21:58 — down, up, and recovery all logged on twin1.
- The recovery flip is the load-bearing test: a probe that
  pages on down but stays silent on recovery trains the
  owner to ignore it. K20's "announce recovery" is this
  line. Every probe shape proves recovery before it ships.
- Unknown is not down: `status: unknown` during
  startup-delay must NEVER page. The loop treats unknown
  as "waiting" (K20: failed-never-green cuts the other
  way too — pending is not verdict).

### 3. Thresholds with hysteresis (prescribed shape, proven reads)

```sh
# Shape (scheduler + script; prescribed — no scheduler drill ran yet):
#   :local free [/system/resource/get free-memory]
#   :if ($free < <alert-bytes>) do={:log warning "<tag>-lowmem"}
#   :if ($free > <clear-bytes>) do={:log info "<tag>-mem-ok"}   # separate clear line
```

- Two lines, not one: the alert value trips, the HIGHER
  clear value resets. A single trip line flaps on every
  boundary crossing and spams the owner — hysteresis is
  the difference between monitoring and noise (K20).
- Reads feeding thresholds are the step-0 inventory
  (free-memory, cpu-load, free-hdd-space, package
  versions). The scheduler/script mechanics are standard
  RouterOS (routeros-scripting) but UNEXECUTED here —
  the first threshold drill updates this skill.
- Dedup window: the loop (T12/#3), not the probe,
  collapses repeats. Probe says it every interval; the
  loop notifies once per state episode. Don't throttle
  the probe to fix loop spam.

### 4. Notify on change only (K20 discipline, prescribed loop)

- Three cadences, separated (K20): COLLECT often (cheap
  reads, every few minutes), INVESTIGATE on state change
  (richer reads only when something moved), NOTIFY on
  transitions + recovery. Steady-state produces log
  lines, never notifications.
- Failed check never renders green: a timed-out read, an
  `unknown` probe, a missing menu is AMBER/unknown in
  every surface (#38 fleet view, #44 board) — never a
  green tick, never silently dropped.
- Notify transports (e-mail via `/tool/e-mail`, webhooks
  via `/tool/fetch`, push via the agent surface) are
  OUTSIDE this drill: prescribed, per-box configured,
  and each needs its own twin proof before the owner
  depends on it. Say which transport, show its test
  message, then trust it.

## Part 2 — Skill doc

### Trigger

Load when: setting up monitoring for a router or fleet;
adding or debugging a netwatch probe; choosing alert
thresholds; wiring a notification path; asking what healthy
looks like for a box; any "why didn't it alert?" postmortem.

### Prereqs

- centrs on PATH; target reachable (`first-contact` first
  on any box not yet in the device registry).
- A twin at matching firmware for probe-shape proofs.
- K20 read (concepts.toml): the cadence/hysteresis/dedup
  vocabulary this skill executes.

### Access

- Twins: anything goes; probe drills are cheap and safe.
- bigdude (production): reads free; ANY write asks the
  developer first — including netwatch adds (config
  writes + probe traffic).
- Operator Unknown → ask before any write (concepts K14).

### Envs

| Name | Use |
|---|---|
| `CENTRS_TIMEOUT` | Default 10s is ample for watch reads |
| `CENTRS_USERNAME` / `CENTRS_PASSWORD` | CLI fallback auth for `--host` targets |

### Outputs

- Read inventory: which watch-menus answer on this box.
- Probe record: host/interval/delay/scripts + the three
  transition log lines (down/up/recovery) with timestamps.
- Threshold record: alert value, clear value, dedup
  window, transport named + test message shown.
- Steady-state note: what silence means (all probes up,
  loop healthy) vs what unknown means.

### Verification

- `/tool/netwatch/print` shows expected states; no
  `unknown` past the startup-delay.
- `/log/print where message~"<marker>"` shows down, up,
  AND recovery lines for every probe shape shipped.
- Re-print after cleanup shows no leftover probes.
- Every owner-facing surface renders unknown as
  unknown — spot-check one amber path per surface.

### Recovery

- Probe stuck `unknown` → check `.about`: startup-delay
  still elapsing is normal; past the delay, the host/
  route is wrong. Never page on unknown.
- Scripts not firing → bodies must be single simple
  statements; check `:log` topics aren't filtered
  (`/system/logging/print`).
- Flapping alerts → widen hysteresis (alert/clear
  spread) or lengthen the dedup window; don't delete
  the probe.
- Log flooded → probe interval too short for the
  transport, or a real flap storm: read the states
  before touching the interval.

### Limits

- The scheduled loop is T12/#3 (unbuilt): this skill
  proves probes, not the loop that reads them on a timer.
- Notify transports are prescribed, each needing its own
  twin proof (test message observed) before trust.
- Threshold scheduler mechanics are prescribed
  (routeros-scripting patterns, unexecuted here).
- CHR proves probe logic only: no sensors, no radios,
  no hardware failure modes. Hardware thresholds need
  hardware (or honest extrapolation, labeled as such).
