---
name: device-selection
description: "Pre-purchase MikroTik advice grounded in the rosetta device DB: inventory-first update advice, greenfield shortlists, and a marked-pending vendor-conversion handoff. Use when: recommending a router/AP/switch buy, answering 'what should I replace X with', sizing a new build, or asking whether a box can run containers."
topics: [device-selection, purchase, rosetta]
tested: none
---

# `device-selection` skill (scenario → inventory → rosetta lookup → purchase rules → advice with gaps)

Pre-sticker TOP-LEVEL advice: this skill runs BEFORE any
buy/label/provision step (#1 unbox-provision is downstream).
Every device fact below is either observed (a rosetta query
in notes/t28-devsel-proof.md, rosetta 0.11.3, DB release
v0.11.3 schema v11) or collected with its citation — never
from memory. Claim labels (observed / collected / inferred /
pending) follow `evidence-ledger`. No twin, no box writes:
rosetta reads + local inventory reads only. Gaps are stated,
not papered over: rosetta has specs and benchmarks but NO
per-device default-config data and NO RF polar-plot data
(R7, pending). Build-tracker references (T/K/R IDs, notes
paths) are pointers pending staging scrub. No secrets below:
rosetta data is public spec data.

## Part 1 — The checklist (advise from lookups, never from memory)

Run top to bottom. No purchase recommendation leaves this
skill without a rosetta lookup behind every device it names.

1. Name the scenario: (a) update advice on an existing
   network, (b) greenfield MikroTik build, or (c) vendor
   conversion → #50 handoff, marked pending (step 0).
2. Inventory FIRST (scenario a): adopt-read the existing
   network before any advice. Advice without inventory is
   guessing (step 1).
3. Look up every candidate in rosetta: exact card or JSON,
   record arch/CPU/RAM/ports/PoE/license/MSRP/benchmarks
   plus the DB release (step 2).
4. Apply the purchase rules: ARM64-for-containers (§3 rule),
   throughput-vs-benchmark fit, port/PoE budget, RAM/storage,
   license level, discontinued flag (step 3).
5. Deliver advice with gaps stated: recommendation + per-device
   citations + explicit unknowns (default-config, RF plots,
   conversion handoff) (step 4).

### 0. Name the scenario (the only branch)

- (a) Update advice on an existing network: the owner has
  MikroTik gear and asks what to change/add. Mandatory next
  step is the inventory (step 1) — "what should I buy"
  without "what do you have" gets no answer yet.
- (b) Greenfield MikroTik build: no installed base (or it
  is irrelevant). Skip step 1; start at step 2 with the
  owner's requirements (site size, link speeds, PoE load,
  container plans, budget).
- (c) Vendor conversion (ubnt/cisco/netgear/linksys in
  place): OUT OF SCOPE here. Capture the old setup +
  inventory (step 1 discipline), shortlist the MikroTik
  side per steps 2–3, then HAND OFF to #50
  vendor-conversion — PENDING, not yet a skill. Mark the
  handoff pending in the advice; do not improvise a
  migration procedure.

### 1. Inventory first (scenario a — advice needs a subject)

- Pull-first per `import-existing-network` (steps 0–3) or
  the lighter `network-workspace-bootstrap` inventory: the
  adopt read (O-facts + A-absences) IS the advice input.
  Collected (import-existing-network SKILL.md).
- Minimum advice-grade inventory: per-device model +
  RouterOS version + role (router/AP/switch), uplink shape,
  PoE sources/consumers, and the complaint (slow where?
  dead spots where? what new load?). An inventory that
  cannot name the bottleneck is not done.
- Captures stay local (`pull/out/`, never published);
  cite redacted facts only (D1). Device-selection adds no
  new capture handling — it consumes the adopt read.
- Greenfield (b) skips this step but still records the
  owner's requirements in the same one-screen shape, so
  the fit checks in step 3 have something to check against.

### 2. Rosetta lookups (every named device, every time)

```sh
rosetta browse --once 'device <name-or-code>'        # exact card + benchmarks
rosetta browse --once '.routeros_device_lookup <query>'   # pipeable JSON
rosetta browse --once '.routeros_device_lookup architecture="ARM 64bit" limit=10'
rosetta browse --once stats                          # DB identity for citations
```

- Observed (t28-devsel-proof.md): `device hAP ax3` returns
  an exact card (ARM 64bit, IPQ-6010, 1 GB, $139, 30
  benchmarks); `.routeros_device_lookup hAP ax3` returns
  the same as JSON (id 73, ram_mb 1024, msrp_usd 139).
  Prefer the dot-command JSON for agent piping (T20
  curation precedent, notes/t20-curation.md).
- Quote multiword filter values: observed that an
  unquoted `architecture=ARM 64bit` splits into
  architecture=ARM + query=64bit and returns 0 rows,
  while `architecture="ARM 64bit"` returns matrix rows.
- Cite the DB release on every rosetta-backed claim (R5):
  this skill's facts are DB release v0.11.3, schema v11,
  built 2026-10-05, version range 7.1.1–7.25rc1; Devices
  155, catalog 258, aliases 1,279, test results 3,162.
  Re-run `stats` when your DB differs — T20's newer
  v0.12.0-next.123 DB had 0 test rows, so benchmark
  availability is PER-RELEASE, not guaranteed.
- Know the three miss shapes (all observed): exact card
  (in matrix, full specs); `like` list (narrow it to one
  exact card before citing); alias/catalog-only
  (e.g. Audience: discontinued, NO spec columns); and
  "No devices found" (e.g. RB953 — older hardware outside
  the matrix; fall back to mikrotik.com/manual pages and
  mark the facts collected-from-vendor, not rosetta).
- Never spec from memory: if rosetta and the vendor pages
  both lack a fact, the advice says "unknown", not a guess.

### 3. Purchase rules (fit checks + the ARM64 rule)

- Throughput fit: compare the owner's load against the
  device's `tests` rows for the MATCHING mode
  (Routing vs Bridging vs Switching, right packet size).
  Observed example: L009 routes 323.6 Mbps (512B, 25
  filter rules) vs 1,269.4 Mbps fast-path — quote the
  rule-loaded row for a firewall box, never fast-path.
- Port/PoE budget: count required ports by speed (1G /
  2.5G / SFP+) and PoE in/out with standards (af/at vs
  passive) from the exact card; the shortlist dies if
  either budget fails. License level from the card too
  (L009 is L5; hAP ax3 and RB1100AHx4 are L6 — observed).
- RAM/storage for the role: containers and dude need
  headroom; 32 MB storage rows (e.g. observed ATL 5G R16
  row: 512 MB RAM / 32 MB storage) rule out container
  roles. State the constraint, not just the winner.
- Discontinued flag: catalog-only/discontinued rows
  (Audience observed) are replace-advice INPUT (scenario
  a), never greenfield picks. Matrix snapshot drift is
  known upstream (#185); re-check live prices/availability
  before the owner pays.
- THE ARM64 RULE (fold-in #53 purchase-arm64-rule): any
  box with a container future must be ARM64. Observed
  ARM64 examples: hAP ax3 (IPQ-6010, $139), RB5009
  family (88F7040, 1 GB, $219/$299/$319). arm32 is
  DOCUMENTED, NOT RECOMMENDED for new buys: L009
  (IPQ-5018 2×800 MHz, 512 MB, $129) and RB1100AHx4
  (AL21400 4×1.4 GHz, $329) are both observed ARM 32bit.
  Collected tension, stated honestly: L009-class arm32
  CAN run containers (two units per
  triage/corpus-local/demo-hardware-notes.md) — the rule
  stands because the container image ecosystem and the
  512 MB ceiling make arm32 a dead end for NEW purchases,
  not because the feature flag is absent. Related
  landed work: S4 arm32 failure-surface map.

### 4. Deliver advice with gaps stated (all scenarios)

- Advice shape: scenario line, inventory pointer (a) or
  requirements (b), shortlist table (device, code, arch,
  role-fit rows, MSRP, rosetta citation), the pick with
  its deciding margin, and a GAPS section. Every device
  row traces to a lookup in the proof style of step 2.
- GAPS (pending, never silent): NO per-device
  default-config data and NO RF polar-plot data in
  rosetta (R7 needed: "Mikrotik PDFs unindexed; both
  needed for device-selection advice"). So: no claims
  about out-of-box behavior beyond what the vendor manual
  states, and no AP orientation/coverage claims beyond
  chain counts + dBi on the card. Multi-AP layout is
  #52 site-plan-multi-ap's problem (pending).
- Scenario (c) handoff: the advice ends with "migration
  procedure: #50 vendor-conversion (PENDING)" plus what
  IS ready (old-setup capture + MikroTik shortlist).
  Do not write migration steps under this skill's name.
- Re-check rule: MSRP on the card is a ranking hint, not
  a price. Confirm live price + stock + RouterOS support
  status before the owner commits; record the check date.

## Part 2 — Skill doc

### Trigger

Load when: recommending a MikroTik buy; answering "what
should I replace X with" or "is X enough for Y"; sizing a
greenfield build; asking whether a box can run containers;
comparing two models; or scoping what an existing network
needs next (then inventory first).

### Prereqs

- rosetta on PATH (`rosetta --version`; 0.11.3 observed).
  Know your DB release (`browse --once stats`) — cite it.
- Scenario (a)/(c): an adopt read exists
  (`import-existing-network` steps 0–3) or you take one now.
- Curation precedent read once: notes/t20-curation.md
  (two-layer lookup, alias map, drift caveats).

### Access

- Reads only: rosetta queries + local inventory reads.
  No twin, no box writes, no production contact — safe
  anywhere, including before first contact.
- Inventory captures (scenario a) stay local per D1:
  cite redacted O/A lines, never serials/IDs/addresses.

### Envs

| Name | Use |
|---|---|
| `ROSETTA_OFFLINE=1` | Skip DB freshness network checks; use the local DB |
| `DB_PATH` | Pin a specific ros-help.db when releases coexist (R4) |

### Outputs

- Advice note: scenario + inventory/requirements pointer
  + shortlist table with rosetta citations + pick +
  GAPS section (+ #50 handoff line for scenario c).
- Proof appendix (proof-file style): every `rosetta
  browse --once` command + redacted output behind the
  device rows. Claim = command + output.

### Verification

- Every named device has a lookup (exact card or JSON)
  with DB release cited; no spec from memory.
- Scenario (a) advice traces each line to an inventory
  fact or a stated requirement; no inventory, no advice.
- GAPS section present: default-config + RF plots (+ #50
  handoff for conversions). MSRP labeled hint, live price
  unchecked unless checked with a date.
- No serials/IDs/addresses/secrets anywhere (D1).

### Recovery

- "No devices found" → fall back to vendor/manual pages,
  mark facts collected-from-vendor; older fleets (RB953
  class) live here.
- Alias/catalog-only hit → treat as replace-advice input
  or a discontinued flag, never a greenfield pick; say so.
- 0-row filter result → check quoting
  (`architecture="ARM 64bit"`); re-run `stats` to confirm
  the DB release still has the rows you expect.
- Benchmarks absent for a device → size from the nearest
  same-CPU sibling and mark inferred, or say unknown.

### Limits

- Rosetta specs + benchmarks only: no default-config
  data, no RF polar plots (R7); no traffic/counter claims
  (specs are not measurements of THIS network).
- This skill advises; it never buys, provisions (#1), or
  migrates (#50). Vendor conversion ends at the handoff.
- Matrix snapshot drift (#185) + per-release test-row
  variance: advice is dated to its DB release and must
  say so. A newer rosetta can change a recommendation.
