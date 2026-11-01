---
name: site-plan-multi-ap
description: "Plan multiple APs on one router the way the owner actually asks: a schematic per-floor grid (rooms as boxes, APs as markers with channel/power/SSID, coverage as labeled sketches) plus computed channel-collision warnings — not a Leaflet map, not traced floorplans. Use when: placing APs across rooms or floors, answering which AP serves where, deconflicting channels, or scoping wifi work on a MikroTik site."
topics: [site-plan, wifi, visualization]
tested: self-test
---

# `site-plan-multi-ap` skill (survey → schematic → deconflict → verify) [template v1 draft]

The common MikroTik shape (several APs on
one router, large home / small business) where an
earlier scoping pass ruled Leaflet NOT the useful view and left the
scheme TBD. This skill DECIDES the scheme (§0, proposed
— ratify or amend with the first real site): a
schematic per-floor grid, no geo, no traced floorplans.
Topology halves route to truthful-topology-graphviz, install content
to field-sheets, per-AP SSID→VLAN builds to wireless-vlan-setup.
The reference renderer
proves the pipeline on a synthetic two-floor fixture:
SVG schematic + AP table with computed channel
warnings + PNG. No twin, no box writes: local render
only. AP specs cited are observed rosetta lookups (DB
v0.11.3, this run), never memory.

## Part 1 — The checklist (rooms first, markers second, channels third)

Run top to bottom. The schematic regenerates from the
survey — hand-moved markers are forgery.

1. Decide the scheme for THIS site (default: schematic
   grid; §0 records what was considered) (step 0).
2. Survey rooms + AP intents in a 10-minute walk: room
   boxes, AP devices, SSIDs wanted, the complaint (step 1).
3. Render the schematic: floors, rooms, AP markers with
   channel/power/SSID, sketch coverage (step 2).
4. Deconflict channels mechanically: same-channel
   adjacency warns, plan clears it (step 3).
5. Verify labels + hand off topology/install/build
   halves to their skills (step 4).

### 0. Decide the scheme (the TBD, closed as proposed)

- REJECTED (a): Leaflet geo map — an earlier scoping
  ruling stands. Reasons recorded: indoor scale is
  meters (geo tiles answer nothing at that zoom),
  there is no GPS indoors to pin against, and the
  owner question ("which AP serves the back bedroom?")
  is room-relative, not coordinate-relative.
- REJECTED as default (b): traced floorplans —
  reasons: real floorplans are sensitive documents
  (privacy cost on every share), tracing is slow per
  site, and a stale tracing misleads worse than a
  schematic (precision implies survey-grade truth the
  agent does not have).
- CHOSEN (c): schematic per-floor grid. Rooms are
  labeled boxes from the owner's walk ("living,
  roughly 6×4 m, ground floor") — relative layout,
  not measured plans. APs are markers carrying
  device/channel/tx-power/SSIDs. Coverage is dashed
  sketch circles labeled "estimate", never filled
  heatmaps. One panel per floor, stacked.
- Why this wins (inferred, developer-ratifiable): it
  answers the two real questions (which AP serves
  this room? do channels collide?) at the cheapest
  survey cost (one walk, no tools), with the lowest
  privacy cost (no real plans change hands), and the
  sketch label keeps it honest (collected precedent:
  map-reports's "a sketch, not a survey" coverage rule).
- Corpus note (observed): a full-text search of
  the design corpus for multi-AP/floorplan/dead-
  spot/roaming/coverage-placement content returned
  nothing on point — this scheme is designed, not
  collected. First real site either ratifies or
  amends it; the skill says which happened.

### 1. Survey (the 10-minute walk)

- Per floor: floor name + rooms (id, label, rough
  w×h in meters). Relative positions ("office north
  of living") suffice — the renderer lays boxes out,
  it does not need measurements.
- Per AP intent: device, room, model shortlist or
  installed model (rosetta card per device-selection — observed
  this run: cAP RBcAP2nD 2×2.4 af/at $49.95; wAP LR2
  kit 2×2.4 passive PoE; DB v0.11.3), SSIDs it must
  serve, PoE source, uplink port → which switch/router
  port (that mapping is truthful-topology-graphviz's input, recorded here).
- The complaint in the owner's words ("garage drops
  under load") + where it happens (room, floor).
  A survey without a complaint is a guess about what
  problem the APs solve — ask.
- Absences to list (same force as import-existing-network): rooms with no
  AP intent, SSIDs with no AP assigned, PoE budget
  unknown, uplink ports unmapped. Empty absences =
  skipped questions, not a complete survey.

### 2. Render (the schematic + the AP table)

- Run `references/render-site-plan.py --fixtures …
  --out …`: per-floor SVG panels (room boxes +
  labels, AP markers colored by band, channel + tx
  text per marker, dashed sketch-coverage circles)
  plus `site-plan.md` (AP table: device/room/channel/
  tx/SSIDs/model-citation + computed warnings).
- Observed (self-test): 3-AP two-floor fixture
  renders SVG that parses as XML; every marker
  carries device + channel; coverage circles are
  dashed with a per-floor "estimate" legend; the
  table cites rosetta cards per AP row.
- Coverage sketch rule (adopted from map-reports): circles
  are free-space-plus-clutter-margin sketches, phone-
  uplink-limited, antenna gain from what the radio
  reports — and the page says "estimate" on them.
  No filled heatmaps (they read as measured truth).
- Pending: first render from a real site survey
  (room boxes from a real walk, installed-model
  cards); DnD-draggable markers are explicitly NOT
  planned (Fix-GPS-style loops stay map-reports's).

### 3. Deconflict (channels, mechanically)

- The renderer computes same-channel adjacency from
  the fixture's `adjacency` pairs: any adjacent pair
  sharing a channel emits `WARN: same-channel
  adjacent <a> <b> ch<N>`. Observed (self-test):
  fixture carries exactly 1 warning; the test asserts
  the count, not just presence.
- Clearing a warning means changing the plan (move a
  channel, move an AP, record why not) and re-
  rendering — warnings are never deleted by hand.
  Zero warnings is the deconfliction signal; a
  tolerated warning ships with its reason on the page.
- 2.4 GHz channel plan is 1/6/11 until a scan says
  otherwise; 5 GHz per local regulation + installed
  radio caps (from the rosetta card, not memory).
  DFS caveats ride with any DFS pick.
- Pending: neighbor-scan input (real RF environment
  data has no skill yet — scans would feed this step
  as a second adjacency source, not a replacement).

### 4. Verify + hand off (labels, then the three halves)

- Verify: room labels on every box; device+channel on
  every marker; "estimate" on coverage; warning count
  printed (zero or tolerated-with-reason); AP rows
  cite rosetta cards; no real addresses/floorplans in
  fixtures (synthetic grid coords only).
- Hand off the halves this skill does not own:
  uplink paths + switch-port mapping → truthful-topology-graphviz
  (DOT→SVG, observed/inferred marking); per-AP
  SSID→VLAN builds → wireless-vlan-setup;
  install/aiming sheets for the AP work → field-sheets
  (pending — the handoff is filed,
  field-sheets stays listed).
- Observed PNG path (self-test): headless-chromium
  screenshot of the inlined SVG at 1080×1350 (same
  flags as map-reports/presentation-layer), checker threshold 32.
- Record per `evidence-ledger`: survey + scheme
  choice + warning count + handoffs filed. First
  real site also records: scheme ratified or amended.

## Part 2 — Skill doc

### Trigger

Load when: placing APs across rooms/floors; answering
which AP serves where; deconflicting channels; scoping
wifi work or a coverage complaint; or extending a device-selection
shortlist with placement.

### Prereqs

- The scheme TBD read (this skill closes it).
- device-selection for AP model cards (specs
  from lookups, never memory).
- python3 + chromium for the reference renderer and
  self-test (stdlib only + local tools).

### Access

- Pure local render: NO twin, NO box writes, NO router
  contact. Safe anywhere, including beside production.
- Surveys of real sites name rooms, never people;
  fixtures are synthetic grids. No credentials, mgmt
  addresses, or floorplan documents in this skill's
  artifacts.

### Envs

| Name | Use |
|---|---|
| `CHROME` | Optional override for the headless browser binary (`test.sh` probes `chromium`, `google-chrome`, `chromium-browser` when unset) |

No secrets, tokens, or API keys — no credentialed door
is part of any path here.

### Outputs

- Site schematic (per-floor SVG panels + 1080×1350
  PNG, dated, estimate-labeled).
- AP table with model citations + computed channel
  warnings (count printed, zero or tolerated).
- Filed handoffs: truthful-topology-graphviz input, wireless-vlan-setup
  build list, field-sheets install-sheet request.

### Verification

- Scheme choice recorded (§0 default or site override
  with reason); first real site says ratified/amended.
- Every marker has device+channel; every room a label;
  coverage dashed + estimate-labeled.
- Warning count asserted mechanically (self-test);
  tolerated warnings carry reasons on the page.
- AP specs trace to rosetta lookups with DB release.
- No real floorplans, addresses, or credentials
  anywhere (privacy rule).

### Recovery

- Survey contradicts installed reality → re-walk the
  delta, re-render; records win over schematics.
- Warning cannot clear (too few channels, too many
  APs) → record as tolerated-with-reason + capacity
  note; never delete the warning.
- Rosetta lacks an installed model → vendor/manual
  fallback per device-selection Recovery, marked
  collected-from-vendor.
- Scheme fails the first real site → amend §0 with
  what the site taught; the TBD reopens honestly.

### Limits

- The scheme is PROPOSED (designed, corpus-silent):
  no multi-AP placement content exists in the corpus
  to collect from. Ratification needs a real site.
- Sketches, not surveys: no measured coverage, no
  neighbor scans, no roaming analysis — the labels
  say so, and the skill refuses heatmap realism.
- This skill places and deconflicts; it never builds
  (wireless-vlan-setup), never maps uplinks (truthful-topology-graphviz),
  never writes install sheets (field-sheets). Halves are handed off, named.
- One site, one schematic: fleet/multi-site AP
  planning has no skill yet — do not stretch this
  one's fixture shape across sites.
