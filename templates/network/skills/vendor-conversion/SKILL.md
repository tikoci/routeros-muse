---
name: vendor-conversion
description: "Migrate a ubnt/cisco/netgear/linksys site to MikroTik without losing what the old setup knew: in-schema capture of the old site, adopt-read facts plus absences, MikroTik shortlist via device-selection, migration plan with per-line provenance, import under approvals. Use when: replacing non-MikroTik gear, adopting a vendor site the owner documented (or did not), or writing a migration plan from someone else's survey."
topics: [conversion, migration, inventory]
tested: self-test
---

# `vendor-conversion` skill (capture → adopt → shortlist → plan → migrate) [template v1 draft]

Backlog #50. Closes the #49 device-selection scenario-(c)
handoff: #49 shortlists the MikroTik side and stops at
"migration procedure: PENDING" — THIS skill is that
procedure. It consumes two landed disciplines without
redefining them: `import-existing-network` (pull-first
adopt: capture → plan is permitted, plan → capture is
forgery; facts AND absences) and `device-selection`
(rosetta-grounded shortlist). The one new thing here is
the OLD-VENDOR half: the old controller does not export
RouterOS, so the capture is a hand/schema survey, not a
pull — and the skill holds the line on what a survey can
and cannot prove. No twin, no box writes: survey reads +
local planning only. The worked example is synthetic
(fictional site, documentation IPs); a first real-vendor
capture is pending.

## Part 1 — The checklist (survey what exists, prove every plan line)

Run top to bottom. Migration writes start at step 5 under
the normal approval rules — steps 1–4 touch nothing.

1. Capture the old setup in-schema: devices, SSIDs, subnets,
   controller shape, complaints — or take the lazy rung and
   mark it (step 0).
2. Adopt-read the capture: O-facts AND A-absences. An
   absence (no guest VLAN, no firewall notes) is a finding
   (step 1).
3. Shortlist the MikroTik side via device-selection
   (inventory-first rule already satisfied by step 1) (step 2).
4. Plan from capture: every plan line traces to a capture
   path or a stated absence; lazy lines stay flagged until
   confirmed (step 3).
5. Migrate under approvals via change-apply; AP layout is
   #52's problem, filed as a handoff not a guess (step 4).

### 0. Capture (the survey — full rung and lazy rung)

- Full rung: walk the old controller/UI (or the owner's
  docs/photos) and fill the capture schema
  (`references/fixtures/old-site-ubnt.json` shows the
  shape): site id, vendor, controller type/version,
  per-device role + vendor model + mgmt address + state,
  SSIDs with auth + VLAN-or-null, subnets with DHCP/DNS,
  an explicit `absences` list, owner complaints with
  `(owner-stated)` markers. Minimum migration-grade
  capture: every device named, every SSID's auth known,
  uplink shape known, absences listed — not empty-by-
  default. An empty absences list means the surveyor
  skipped the question, not that the site is complete.
- Lazy rung (the owner is lazy): fill what the owner can
  dictate in one sitting plus training-default guesses
  for the rest. Every guessed field is marked
  `lazy + confirm-before-migrate` by the planner
  (`← lazy:` provenance). Lazy lines may shape the
  shortlist; they may NOT drive a migration cutover
  until confirmed by capture or owner sign-off.
- Owner-stated vs observed: anything the owner said but
  no screen showed is `(owner-stated, unverified)` in
  the capture — the planner carries that marker into the
  plan. Collected precedent: #2's O/A discipline, #30's
  claim labels.
- Observed (this skill's self-test): `references/
  plan-from-capture.py` rejects captures missing any of
  `synthetic, site, old_vendor, devices, ssids, subnets,
  absences` (exit non-zero), so a half-filled survey
  cannot silently become a plan.

### 1. Adopt (facts plus absences — #2's rule, survey edition)

- Run the #2 adopt read on the capture file instead of a
  pull: O1–O5 facts (what exists, with capture paths)
  plus A1–A4 absences (what the capture does NOT show).
  The planner emits both halves automatically; the agent
  checks the absences half is non-trivial before
  proceeding.
- Absences that recur on vendor sites (inferred from the
  fixture shape, confirm per site): guest isolation done
  as an AP feature with no guest VLAN underneath;
  firewall rules undocumented ("default + clicked
  things"); no backups; controller version recalled, not
  read. Each becomes a plan line ("create guest VLAN;
  do not trust AP isolation across vendors").
- STOP rule (same force as #2's): no plan step may
  require a box capability the capture does not show AND
  the shortlist does not provide. Unknown uplink shape →
  no cutover date. Unknown PoE budget → no AP count.
- Captures of real sites stay local (same D1 handling as
  `pull/out/`): cite redacted O/A lines, never mgmt
  addresses/credentials. The fixture uses TEST-NET-2
  (198.51.100.0/24) plus `synthetic: true` so it can
  never be mistaken for a real site.

### 2. Shortlist (the MikroTik side — #49 does this)

- Hand the adopt read to `device-selection` as its
  scenario-(a) inventory: per-device role, uplink
  shape, PoE sources/consumers, the complaint. #49's
  inventory-first rule is satisfied by steps 0–1, not
  waived.
- Role mapping the shortlist must cover (plan lines
  reference these): gateway (uplink type incl. PPPoE/
  DHCP/static from capture), switching + PoE budget,
  AP count by coverage need (count only — placement is
  #52), controller-or-not (no self-hosted controller
  on the MikroTik side unless the owner asks; say what
  replaces the old controller's jobs: backup, alerting,
  guest portal).
- Constraints from the fixture run (observed shape):
  container ambitions need ARM64 (#49 rule); 32 MB
  storage rows rule out container roles; license
  levels come from the rosetta card, never memory.
- This skill never shortlists: if #49's GAPS section
  (default-config, RF plots) blocks a role, the plan
  says so and the migration waits. Do not improvise
  device advice under this skill's name.

### 3. Plan (every line proven — the planner's contract)

- Run `references/plan-from-capture.py <capture.json>`:
  one STEP per device, SSID, subnet, and absence, each
  carrying exactly one provenance marker —
  `← capture:<json-path>`, `← absence:<fact>`, or
  `← lazy:<field> (confirm before migrate)`. Observed
  (self-test): 12/12 steps on the fixture carry a
  marker (5 devices + 2 SSIDs + 1 subnet + 3 absences
  + 1 complaint); the test fails the plan if any step
  lacks one.
- Cutover order is part of the plan: mgmt access first
  (new gateway reachable + rollback path open), then
  switching/PoE, then APs one at a time with the old
  SSID kept up until the new one proves (client-visible
  continuity), guest network last (it has the weakest
  pre-migration proof). Rollback per phase: what
  "back out" means while the old gear is still on site.
- Lazy lines gate phases: a phase whose steps are all
  `← lazy:` does not schedule until confirmed. The
  plan prints its lazy count at the top — that number
  reaching zero is the migration-readiness signal.
- Observed fixture findings (synthetic, shape-only):
  guest isolation is AP-feature-only with no VLAN
  underneath → plan creates a real guest VLAN (#7
  wireless-vlan-setup owns the procedure); firewall
  rules undocumented → plan re-derives from observed
  traffic needs, never "copies" unknown rules.

### 4. Migrate (writes begin — all under approvals)

- Execute the plan back onto the NEW boxes via
  `change-apply` (twin-proof, propose, stage, run,
  read back, clear) — one phase at a time, read-back
  before the next phase starts. The old gear stays
  powered until the new SSIDs prove with real clients.
- AP placement is NOT decided here: file a handoff to
  #52 site-plan-multi-ap (pending) with the coverage
  need + the complaint (e.g. "garage drops under
  load"). A migration plan that places APs by vibes
  fails this skill's verification.
- Guest VLAN build hands to #7 wireless-vlan-setup;
  firewall rows hand to `firewall-apply`; the whole
  run is recorded per `evidence-ledger` (dated,
  command + output, claim labels).
- Pending (no real-vendor run yet): first capture of a
  live ubnt/cisco/netgear/linksys site; first cutover
  executed from a planner-generated plan; lazy-to-
  confirmed conversion rate (how much of a lazy survey
  survives contact with the site).

## Part 2 — Skill doc

### Trigger

Load when: replacing non-MikroTik gear; adopting a vendor
site with (or without) docs; writing a migration plan
from someone else's survey; answering "can we move this
site to MikroTik"; or closing a #49 scenario-(c) handoff.

### Prereqs

- Backlog #50 + #49 scenario-(c) handoff terms read.
- `import-existing-network` adopt discipline (O/A read,
  STOP rule) + `change-apply` procedure available.
- Bun or python3 for the reference planner and self-test
  (python3 stdlib only — no deps).
- For a real site: read access to the old controller/UI
  or the owner's docs; write approval comes later via
  change-apply, never assumed here.

### Access

- Survey reads + local planning only: NO twin, NO box
  writes, NO router contact in steps 1–4. Safe anywhere,
  including beside production.
- Real-site captures are handled like pulls (local-only,
  redacted citation, no mgmt addresses or credentials
  in plans or proofs). Fixtures are synthetic + TEST-NET
  and safe to keep in-tree.

### Envs

| Name | Use |
|---|---|
| `CAPTURE_JSON` | Optional input path for `plan-from-capture.py` (default: the fixture) |

No secrets, tokens, or API keys — the old controller is
read through its UI by a human or a screen session, and
no credential of it enters this skill's artifacts.

### Outputs

- Old-setup capture (in-schema JSON, absences explicit,
  lazy fields flagged).
- Adopt read (O-facts + A-absences with capture paths).
- Migration plan (provenance-marked steps, phased
  cutover order, rollback per phase, lazy count).
- Handoffs: #49 shortlist in, change-apply + #52 + #7
  out, each with its readiness condition.

### Verification

- Schema check: capture validates (planner exit 0);
  `absences` non-empty; `synthetic` flag present and
  true for examples, absent/false only for real sites.
- Provenance check: EVERY plan step carries exactly one
  `← capture:|← absence:|← lazy:` marker (self-test
  asserts this mechanically).
- STOP-rule check: no step needs an unknown uplink,
  unknown PoE budget, or an AP placement (→ #52).
- Lazy check: lazy count printed; zero-lazy required
  before any cutover phase schedules.
- Privacy audit: no real mgmt addresses, credentials,
  or owner identifiers in captures kept or cited.

### Recovery

- Capture rejected by the planner → fill the missing
  keys (the error names them); do not hand-edit the
  plan to skip the survey.
- Owner contradicts the capture → the capture wins
  until re-surveyed; record the dispute as an absence
  ("uplink shape disputed") and stop the affected phase.
- Shortlist blocked by #49 GAPS → the plan waits;
  downgrade the phase to "pending", never to a guess.
- New findings mid-migration → re-capture the delta,
  re-plan the remaining phases, keep the old gear until
  the revised plan's read-backs pass.

### Limits

- No real-vendor run yet: planner + schema + provenance
  rule are proven on a synthetic fixture; first live
  capture and first executed cutover are pending.
- This skill surveys and plans; it never provisions
  (#1), never writes (change-apply), never places APs
  (#52), never builds VLANs (#7) or firewall rows
  (firewall-apply). Handoffs are named, not absorbed.
- Training-default (lazy) knowledge is second-class by
  design: useful for shortlists, forbidden as cutover
  proof. The lazy count is the honesty instrument.
- Vendor coverage is schema-deep, not integration-deep:
  no controller APIs, no config importers — the survey
  is human-driven until a vendor-specific importer
  earns its own skill.
