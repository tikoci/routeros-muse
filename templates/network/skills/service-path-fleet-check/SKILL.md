---
name: service-path-fleet-check
description: "Poll the fleet along the service path: outward-from-main ordering, per-device outcomes, shared-path correlation, hysteresis and recovery discipline. Use when: checking fleet health, triaging multi-device symptoms, designing poll loops, or deciding whether one box or a whole path is down."
topics: [fleet, polling, alerting, monitoring]
tested: none
---

# `service-path-fleet-check` skill (order → poll → correlate → notify) [template v1 draft]

Promoted from the source-verified status layer (concept review §10:
outward-from-main, per-device outcomes, retained errors), the
cadence recommendation (§11: collect/investigate/notify +
hysteresis + dedup + recovery), the scheduler shape (60s
non-overlapping jobs, /about diagnostics), and K20. Backlog #38.
No secrets below; device names are roles.

## Part 1 — The checklist (places first, then boxes)

Run top to bottom. The human sees places and connected equipment,
not an alphabetized fleet — the poll order mirrors the service
path a symptom would travel.

1. Order outward from main (§0): site → main device → along
   links → unvisited stragglers; Service-path order, always.
2. Poll with per-device outcomes (§1): bounded parallel reads,
   each device its own verdict, failures retained as errors.
3. Correlate before alarming (§2): unreachable downstream =
   shared-path hypothesis first, not N broken boxes.
4. Notify on change with hysteresis (§3): collect ≠ investigate
   ≠ notify; dedup, recovery announce, never green-on-failure.

### 0. Order (outward from main)

Source-verified shape (concept review §10): inventory is network
→ sites → devices with explicit links and each site's main
device. The status layer filters by site and ORDERS DEVICES
OUTWARD ALONG LINKS FROM THE MAIN ROUTER, then includes
otherwise unvisited devices. It groups by location and exposes
site navigation.

- Devices are stable IDs: "the AP serving this room" ≠ "the
  physical unit currently installed there" (device record:
  stable ID, site, location, role, label, model, serial,
  planned/reachable addresses, drift — intent and reachability
  separated).
- Poll in path order (main → transit → edge), not alpha order:
  when the main is down, everything downstream reads
  unreachable — path order makes that ONE finding with a
  location, alpha order makes it N alarms.
- Execution location decides addresses: management vs overlay
  addresses depend on where the check runs from (source-verified
  — record the vantage with the results, or identical checks
  disagree for no visible reason).
- Unvisited stragglers (no link path from main) poll LAST and
  flag the inventory gap: a device unreachable-by-topology is
  either new, moved, or mis-recorded — all three are findings.

### 1. Poll (per-device outcomes, failures retained)

- Bounded parallel reads (recommendation §10): independent
  reads fan out with a bound (centrs fan-out > shell loops —
  one envelope, per-target errors that don't abort the rest);
  dependency-sensitive WRITES sequence deliberately. Reads
  parallel, writes serial — different handling, stated each
  time.
- Per-device collection AND execution outcomes, shown per
  device: "a successful call to one router is not fleet-wide
  success." The fleet verdict is a TABLE (device → outcome),
  never a boolean. The CMR trial's per-device run-script
  output is the same shape, different tool.
- Failed reads are RETAINED AS ERRORS, never discarded
  (source-verified): a failed collection renders as
  UNRESOLVED, never green (muse feedback §4.1; K20: "a failed
  check never renders green"). A silent "all green" from a
  run that never reached the router is the worst outcome
  (homework §3) — the poll proves contact per device or says
  which device it never reached.
- Live link checks inspect BOTH ends (source-verified):
  radio/link state from each side; one-sided reads mislead
  (the far end's view of the link is data the near end
  can't supply). Asymmetric results (A sees B, B silent)
  are a directional finding, not a flapping one.
- Scheduler shape (source-verified §11): small in-process
  loop, ~60s delays, each job awaits completion before
  rescheduling (a job never overlaps ITSELF; separate jobs
  may run concurrently). Diagnostics per job: name,
  interval, last run, duration, last error; `/about`
  exposes them. Effective spacing INCLUDES execution time;
  state is process-local (persist incident/notification
  state if it must survive restart — recommendation).

### 2. Correlate (shared path before broken boxes)

- An unreachable downstream GROUP is a possible SHARED-PATH
  failure first (recommendation §10): main-down explains
  edge-silence. Correlation is a HYPOTHESIS until checked —
  verify the path device before declaring the leaves dead,
  but don't page N device owners for one uplink.
- Expected-absence states (recommendation §10): include
  expected-offline, not-yet-installed, and maintenance in
  the state model so planned absence never becomes alarm
  noise. (Private workspace already handles expected
  absence; general maintenance workflow stays a proposal —
  mark which half you're using.)
- Scope proposals to the SERVICE: list all affected devices
  INCLUDING the router hosting the agent's own access path
  (recommendation §10). The poll that kills its own route
  to report is a special kind of wrong — the access-path
  device gets named before any action touching the path.
- Site copies serve pages separately: report which site
  copy serves a view and which copies received a
  publication (recommendation §10) — a whole-network
  workspace can still have per-site deployments, and
  "the dashboard says X" needs a WHICH-dashboard.

### 3. Notify (three cadences, change-only, recovery announced)

K20 + recommendation §11 (proposed there — the inspected
scheduler does NOT implement a complete notification service;
this skill carries the recommendation as the target shape):

- THREE CADENCES, separated: data collection (cheap, frequent,
  no model, no human), agent investigation (on meaningful
  change — a model looks), owner notification (on what the
  owner must know). Most polls need NO model invocation and
  NO message to a person. Merging them pages humans for
  routine and burns tokens on calm.
- Hysteresis on intermittent faults: flap × N inside window T
  before the first notify (numbers per deployment, stated —
  the five-minute collection / eleven-minute stale-threshold
  pair in §11 is deployment-specific, NOT a default).
- Dedup repeated alerts: one incident, one notification
  thread, count attached ("still down, 14th poll") — never
  14 messages. Persist the incident state if restarts must
  not re-page (recommendation).
- ANNOUNCE RECOVERY, always: the resolve message is as
  load-bearing as the alert ("site X reachable again after
  22m" closes the human's open loop). A system that pages
  down but never up trains owners to ignore it.
- Escalate on MEANINGFUL change only (K20: notify on change
  only): new failure, state flip, threshold cross, recovery.
  Steady-state — good or bad — is a dated view, not a
  notification (workflow Reports rule).

## Part 2 — Skill doc

### Trigger

Load when: checking fleet health; multiple devices symptom
at once; designing or debugging a poll loop; "is the fleet
ok?" questions; deciding poll vs CMR-consume architecture.
(Entry-skill + capability-probe pattern: K22.)

### Prereqs

- Inventory with sites, main devices, links (network → sites
  → devices — §0 order needs the graph).
- Per-device access (agent-access-bootstrap reader minimum)
  + known execution vantage (which addresses, §0).
- Cadence numbers chosen (collect interval, hysteresis
  window, notify rules) — stated, not defaulted.

### Access

- Polling is reads: safe on all boxes anytime (bigdude
  included). Poll loops are the gentlest fleet load —
  keep them read-only and they stay welcome.
- Investigation may write (diagnostic toggles, test peers):
  twin-first or approved-change rules apply once the poll
  becomes a probe.
- Notification paths (mailbox, webhook, coordinator) need
  no router rights — but their failure modes need OWNING
  (a notifier that can't notify is §1's worst outcome).

### Envs

| Name | Use |
|---|---|
| `CENTRS_TIMEOUT` | Per-read bound inside the poll (a hung read must not eat the loop) |

### Outputs

- Per-device outcome table (device → collected/executed/
  error), path-ordered, vantage-stated.
- Correlation verdict (shared-path hypothesis ± check).
- Notifications sent (change-only) + recovery announcements.
- Scheduler diagnostics (per-job last run/duration/error).

### Verification

- Every device has an outcome row — no silent skips (the
  table's completeness IS the coverage proof).
- Failed reads render unresolved-with-reason, never green
  (spot-check one failure rendering per loop change).
- Recovery announced for every notified failure (match
  alert→resolve pairs in the ledger).
- Cadence separation holds: collect runs show no model
  calls, notify log shows change-only (audit both).

### Recovery

- Poll loop died silently: the loop needs its own
  watchdog (last-run staleness alerts — who watches the
  watcher is part of the design, not an afterthought).
- Mass-unreachable event: §2 shared-path FIRST (check
  main/uplink), then leaves. Page the path owner once,
  not N device owners.
- Flapping storm: widen hysteresis (stated, temporary,
  with a restore time) — don't silence; widen and watch.
- CMR-enrolled fleets: prefer CONSUMING CMR alerts
  (cmr-fleet-guard) over this poller; this skill covers
  non-enrolled fleets, pre-enrollment, CMR-down fallback,
  and service-path checks CMR can't express (end-to-end
  service proof). Both, never neither, never confused.

### Limits

- Source-verified SHAPES (§10 status layer, §11 scheduler
  mechanics) + PROPOSED alerting (§11 cadences/hysteresis/
  dedup/recovery unimplemented in the inspected code):
  the poll half is prior art, the notify half is target
  shape. First implementation grounds §3's numbers.
- Complements look-after-ops (#3) and monitoring-alerting
  (#13), not a dup: those own the loop lifecycle + what
  to watch; this owns the fleet CHECK (order, outcomes,
  correlation). Cite, don't re-derive.
- Expected-absence exists; general maintenance workflow
  is proposal-only (§10) — maintenance windows are manual
  until someone builds that workflow.
- Radio/link truth needs both ends live: single-ended
  checks during an outage are explicitly one-sided —
  label them so, don't infer the far end.
