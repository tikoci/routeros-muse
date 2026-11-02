---
name: cmr-fleet-guard
description: "Consume CMR fleet supervision safely: enrollment-only discipline, alerts by webhook or email, own upgrade rule first, run-script guard. Use when: enrolling routers in CMR, setting fleet alerts, planning upgrades through CMR, or auditing controller access."
topics: [cmr, fleet, alerts, upgrade]
tested: none
---

# `cmr-fleet-guard` skill (enroll → consume → pin → guard) [template v1 draft]

Promoted from a journaled 7.26beta CMR trial,
the run-script guard (centrs#456), a twin phone-home
journal, the routeros-cmr domain skill (7.26beta1
CHR), and read-only menu probes on 7.26beta3.
No secrets below; controller addresses stay shapes.

## Part 1 — The checklist (CMR manages; the agent watches)

Run top to bottom. CMR is the fleet's supervisor, not the agent's
hands: the agent consumes supervision, it doesn't wield it.

1. Enroll deliberately (§0): client joins the controller, pairing
   approved both sides, labels set — enrollment only.
2. Consume alerts, don't build a poller (§1): webhooks or email
   into the agent loop; CMR watches, the agent reacts.
3. Pin upgrades with your own rule first (§2): the default rule
   offers a downgrade — never let it near the fleet.
4. Guard the controller (§3): any login there is fleet-write;
   sanitize CMR addresses out of twins.

### 0. Enroll (client joins, both sides approve)

Domain mechanics live in routeros-cmr (7.26beta1 CHR — pairing
matrix, discovery, TCP/54321, labels); this skill is the discipline
on top. Twin-confirmed on 7.26beta3: built-in
`/cmr/client` present (`enabled: no` default), controller `/cmr`
absent without the package.

- Enrollment is the ONLY agent-driven CMR write in the normal
  flow: point the client at the controller
  (`/cmr/client set enabled=yes controller-addresses=<addr>` or
  neighbor discovery), approve pairing BOTH sides (client
  requirement × server per-device requirement — six combinations
  verified in the domain lab), set explicit labels for rules.
- Pairing credentials are RouterOS logins, not a CMR password:
  controller-side `device/pair` uses an account ON THE CLIENT,
  client-side `pair` uses an account ON THE CONTROLLER. Real
  client credentials + explicit controller approval is the
  normal flow; `none` client-side still needs the controller's
  independent password/confirm before management begins.
- Never toggle `enabled` on a paired client (7.26beta1: clears
  client-side approval → waiting-for-pairing + REMOTE-PENDING;
  a reboot does NOT do this). Pairing state is precious — treat
  enable-toggles as re-pairing events with a plan, not hygiene.
- Controller's own device row shows `connected=false` while its
  self-client is paired and scripts run on it — don't require
  the C flag on that row for fleet readiness (domain lab).

### 1. Consume (alerts in, no home-built poller)

[OPINION, journaled trial]: have the agent CONSUME CMR alerts
rather than build its own fleet poller. Trial evidence:
pairing + run-script fan-out with per-device output +
a "disconnected >30s" alert firing ~35s after a test CHR stopped
+ an upgrade through CMR.

- Webhook rung (true push): `action.http-url/method/body/headers`
  with substituted device data; rule evaluation can take up to
  a minute — bounded polling for the FIRED state, never assume
  immediacy. Check `action-failures` as well as delivery.
- Email rung (poll underneath): routers send natively
  (`/tool/e-mail`, also from netwatch/scheduler); a frequent
  mailbox check notices in minutes. Sandbox verdict: no event
  source pushes on new email — email→agent is poll, webhook→
  Cloudflare is the true-push rung. Promise scheduled
  detection with honest latency, not push.
- Alert hygiene from the domain lab: first-bridge-added never
  fires `interface-added` (per-device, reproduced ×3 — pre-create
  a bridge loopback before relying on interface alerts);
  `interface-type` covers only any/ethernet/wifi/bridge (VRRP
  additions never alert); log alerts install a managed
  `/system/logging action=cmr` entry — wait for it before the
  test log line; `upgrade-done` takes `success`/`fail`, not a
  boolean; identify devices by identity/label, never `[address]`
  (down devices report `unknown`).
- CMR watches RouterOS devices ONLY — no ping, SNMP, or HTTP
  probes for anything else. It is not a Dude replacement; the
  fleet's non-RouterOS gear needs its own watcher (or none).

### 2. Pin (your own upgrade rule, before anything else)

- CMR's dynamic default upgrade rule is `channel=stable` and
  CANNOT be edited (`can't edit default rule`): on a beta
  controller it offers a DOWNGRADE (trial: 7.24.5 offered on a
  beta controller) that would drop the CMR package. Add your
  own rule FIRST — before enrolling the second device, before
  any upgrade conversation (trial + guard notes agree).
- Rule shape (domain skill, never-triggered in testing):
  `/cmr/upgrade/add name=<pinned> labels=<fleet> channel=<ver>
  strategy=sequential fail-policy=stop` — assert every device
  selects it; never call `upgrade`/`trigger` without the
  approval + deadman of a normal change (change-apply).
- `packages-directory` must exist and end with `/` (missing
  slash → `input does not match any value`); changing it
  RESTARTS CMR and clients reconnect (documented behavior, not
  a bug — don't report it as one).
- `/cmr/export` (even verbose) and full `/export verbose` OMIT
  controller settings (`enabled`, package directory) AND the
  paired device inventory: export alone cannot reproduce the
  controller. Keep a binary backup (proven: save → disable →
  load → settings/identities/labels/pairing-IDs match) and
  separately record controller settings alongside any export
  (capture-drift-hygiene: the pull's file list is the
  completeness statement — CMR's absence from it is a finding).

### 3. Guard (controller login = fleet-write)

- CMR `run-script` ran fleet writes for a controller login with
  NO `write` policy (centrs#456, closed in
  centrs as RouterOS behaviour). Rules: keep `--cmr` OUT of
  any remote or agent profile; treat ANY login on a CMR
  controller as fleet-write capability regardless of its group
  (agent-access-bootstrap policies don't bound this — the
  controller does what the controller does).
- Enrollment-only discipline: after §0, the agent's CMR surface
  is reads (device rows, alert states, fired counters) +
  alert consumption (§1). Fleet writes (run-script, upgrade
  trigger, pairing changes) ride the normal change path with
  approval — never casual, never from an agent profile.
- Twin phone-home journal (resolves
  the twin-ops sanitization carryover for the CMR case): a twin
  booted from an owner's export containing a CMR controller
  address joins the REAL fleet. Sanitize controller addresses
  (and cloud/BTH tokens) BEFORE booting a twin from
  production-derived state. Same rule as VPN-join and
  TUNNEL_TOKEN in that journal — one rule, three vectors.

## Part 2 — Skill doc

### Trigger

Load when: enrolling routers in CMR; setting or triaging fleet
alerts; planning upgrades through CMR; auditing who can reach
the controller; "the fleet did X, why" questions. (Entry-skill +
capability-probe pattern.)

### Prereqs

- routeros-cmr domain skill for mechanics (pairing matrix,
  discovery, alert/rule syntax) — this skill is the discipline,
  that skill is the manual.
- Controller identified (version recorded — beta vs stable
  changes the default-rule hazard) + client versions recorded.
- Alert sink chosen (webhook listener or watched mailbox) with
  honest latency expectations (push vs poll, §1).

### Access

- Enrollment + controller config: writes — approval per item;
  the developer approves. Controller login credentials
  are owner-custody (fleet-write equivalence, §3).
- Alert consumption: reads + the sink's receive path. No
  approval needed to WATCH; approval needed to ACT on what
  the alerts say.
- Agent profiles never carry `--cmr` or controller scope.
  Ever. (Guard table — no exceptions noted.)

### Envs

| Name | Use |
|---|---|
| (none) | CMR speaks RouterOS + webhooks; no environment. |

### Outputs

- Enrollment record: device, labels, pairing requirements
  satisfied each side, controller version.
- Alert rules (named, labeled, tested-fire where feasible) +
  sink + latency statement.
- Pinned upgrade rule (devices selecting it asserted) +
  binary-backup location + recorded controller settings.
- Guard attestation: controller logins inventoried, agent
  profiles CMR-free, twin-sanitize rule cited.

### Verification

- Every device paired,connected (except the controller's own
  row: paired self-client, C flag not required).
- Test alert fired end-to-end (marker log → webhook/mailbox)
  with `fired` counters + `action-failures` checked.
- Every device selects the pinned rule (NOT default);
  `upgrade`/`trigger` never called outside an approved change.
- Controller login inventory complete; no agent profile
  resolves CMR scope (re-check after profile changes).

### Recovery

- Accidental default-rule upgrade/downgrade: incident-response
  + the binary backup (settings + pairings restore from it;
  exports don't carry them). Write up how the default rule
  got a clear shot — the pin (§2) failed somewhere.
- Client stuck waiting-for-pairing: check BOTH requirements
  (client × server matrix), re-approve the missing side;
  never toggle `enabled` to "unstick" it (re-pairing event).
- Reconnect stall ~90s after route flap: known shape (SYN via
  default route holds the source) — the domain lab rejects
  tcp/54321 off the management NIC with RST; don't misread
  as a CMR bug.
- Controller unreachable: clients run on (CMR supervises,
  doesn't carry traffic) — fix the path, pairings survive
  reboots on both ends.

### Limits

- Domain lab is 7.26beta1; trial journal is 7.26beta; twin
  probes here are 7.26beta3 menu-presence only. Version skew
  across the three is real — re-prove pairing/alert/upgrade
  rows when the fleet's version moves.
- CMR procedures collected, not re-run against a live
  controller (none built here): enrollment-first-run grounds
  them; until then the domain skill + journals are the
  authority, cited as collected.
- WiFi/VLAN provisioning, DHCP discovery, apptraffic,
  dashboards, push-button pairing: docs-only everywhere —
  unrun, unpromised.
- ROS-only supervision: non-RouterOS gear is invisible to
  CMR by design — a fleet with such gear needs a second
  watcher or an explicit blind spot, stated.
