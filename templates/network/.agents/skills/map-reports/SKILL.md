---
name: map-reports
description: "Show the owner where things are and what covers what: one generated Leaflet page per site from records (never hand-edited), KML truth that round-trips through Google Earth, 1080x1350 PNGs for the phone thread, install photos filed as evidence, and the Fix-GPS correction loop back into the records. Use when: mapping device positions or coverage, rendering a setup sheet or annotated map image, filing install photos, or accepting a location correction from the owner."
topics: [reports, maps]
tested: self-test
---

# `map-reports` skill (records → map → image → evidence → correction) [template v1 draft]

The owner never reads TOML or a RouterOS command —
about half the physical-world work (siting, aim, power, install)
ended as something to *show* the owner: a map, a marked photo, a
sheet for the person on the pole (collected: earlier field runs).
This skill holds the MAP halves of the presentation
work: site-map generation plus the map halves of
setup-sheet-png-render, install-photo-evidence, and
human-correction-roundtrip. The FIELD halves (device jobs,
expected-result/stop-condition sheets, hands-work artifacts)
belong to pending field-sheets — that boundary is marked in
every step below, and field-sheets stays listed, never absorbed silently.
Geo maps live here (where sites sit); logical topology lives in
truthful-topology-graphviz (links/paths/neighbors, DOT→SVG).
No secrets below; fixtures are synthetic, never a real place.

## Part 1 — The checklist (generated from records, never hand-edited)

Run top to bottom. Every artifact regenerates from the records
after any correction — hand-editing a generated page or map is
forgery of evidence, not a shortcut.

1. Source positions from records (§0): KML truth in, `gis`
   block per site, public-data layers named with source labels.
2. Generate the map page (§1): one Leaflet page per site —
   backgrounds, GIS overlays, records on top, honesty labels.
3. Render the image artifacts (§2): 1080×1350 PNG path via
   headless browser (map half of setup-sheet-png-render).
4. File image→data evidence (§3): install photos unchanged +
   hashed + EXIF-indexed, never used as precise pins (map
   half of install-photo-evidence).
5. Close the correction loop (§4): Fix-GPS page emits
   structured corrections; agent applies, regenerates,
   publishes (map half of human-correction-roundtrip).

### 0. Source (KML truth + the `gis` block)

- The architect's Google Earth KML is the source of truth for
  positions: the map reads it, and Fix GPS writes corrections
  back in the same format. KML means the owner can also open
  it in Google Earth on a phone, with no new app (collected:
  earlier field runs).
- The template carries a `gis` block per site: layer URLs,
  fields to keep, and a source label per layer (inferred
  shape, collected proposal from earlier field runs).
  `references/fixtures/gis.json` shows the
  shape; operators bring their own layer URLs.
- There is no Meta maps API — no public tiles/geocoding SDK
  under a Meta brand. Geographic site maps render via
  OSM/MapLibre or the Muse app's own map widgets (geocoding
  tool, Places connector); Meta's footprint is open-data, not
  API (collected: the platform tooling explainer). If
  street-level context ever matters, Mapillary is the one
  speculative Meta asset — not planned.
- Fetched features cache by bounding box; a cached box that
  already contains the requested one is reused, so a small
  GPS correction does not refetch everything (collected:
  earlier field runs).
- Privacy is load-bearing: the map is the most
  location-revealing thing the workspace makes. Choose
  parcel fields so no owner names come through; never show
  it in public video without blurring; keep the GIS cache
  out of any public repo (collected: earlier field runs).

### 1. Generate (one Leaflet page per site)

- One generated HTML page per site (Leaflet, no build step),
  regenerated from the records, never hand-edited. Layers
  (collected: earlier field runs):
  - Backgrounds: satellite, topographic, and USGS 3DEP
    LiDAR hillshade — the hillshade shows ridges, gullies,
    and tree lines that satellite hides, and that is what
    decides where a radio link works.
  - Public GIS overlays from county ArcGIS REST
    FeatureServers (parcels with NO owner names, roads)
    and USGS NHD (streams).
  - Records drawn on top: each device at its location;
    radio links coloured by clear-air link budget;
    estimated Wi-Fi coverage; planned cameras.
- The coverage estimate says what it is: free-space loss
  plus a flat clutter margin, limited by the phone's
  uplink, antenna gain from what each radio reports. "A
  sketch, not a survey" is written into the model AND the
  page — that label is what made it safe to show a
  non-expert (collected: earlier field runs).
- Present-it rule for this artifact (from earlier field runs):
  owner asking "where / what covers
  what" gets the site map (page or single image) with
  source labels per layer, "estimate" on coverage, and a
  capture date.
- Observed (this skill's self-test): `references/build-map.ts`
  generates a self-contained Leaflet page from synthetic
  fixtures — vendored Leaflet 1.9.4 inlined, devices as SVG
  markers coloured by budget, link polyline, dashed coverage
  circle with the honesty label, per-layer source footer,
  revision id + generated time. Fixture mode uses no tile
  layer and zero page-initiated network requests, so the
  test renders fully offline.
- Pending: first render against real records + live tile/GIS
  endpoints (needs sandbox egress probes: ArcGIS, USGS
  hillshade, OSM tiles through the proxy — collected probe
  list from earlier field runs).

### 2. Render (the 1080×1350 PNG path — MAP half of setup-sheet-png-render)

- The owner looks at things on a phone, in a text thread —
  the useful output is often a PNG/JPEG, not a web page
  (from earlier field runs). The render primitive:
  a `?p=N` query renders a single page, and a headless
  browser screenshots each page to its own PNG, ready for
  iMessage/RCS. The same records give an HTML version for
  printing. Page size is 1080×1350, phone portrait.
- One-off annotated maps (satellite tile + proposed link
  drawn and labelled, sent as a single JPEG) were composed
  by a small tile/line/label program on macOS; on Linux
  the equivalent is a headless Chromium screenshot of the
  map page, or a small canvas render (from earlier
  field runs). Whiteboards screenshot the same
  way (boards themselves are decision-board-lifecycle).
- Observed (this skill's self-test): headless Chromium
  renders the fixture page to an exact 1080×1350 PNG
  (`references/test.sh` asserts dimensions + non-blank via
  `references/check-png.py`; 564 unique sampled colors on
  the proving run). The PNG-path mechanism is proven; only
  real-record content is pending.
- Pending (collected day-0 probes from earlier field runs):
  sandbox-generated PNG shown inline in the Muse phone app;
  headless browser available in the sandbox (its browser
  cannot reach loopback, but a file render may still work).
- Boundary with field-sheets (still pending): the
  sheet CONTENT for hands work — IKEA-style per-location
  pages, what-plugs-into-what, compass-words aiming, "how
  to tell it worked", "if not, stop and send a photo" —
  belongs to field-sheets. This skill owns only the render
  primitive (`?p=N` + headless screenshot + print HTML from
  the same records). field-sheets stays listed.

### 3. File (image→data evidence — MAP half of install-photo-evidence)

- Pictures also flow into the records (collected:
  earlier field runs): phone panoramas fitted to a LiDAR
  skyline (recovered position/heading when phone GPS was
  ~90 m stale and compass ~95° off; same fit gave
  winter-sun hours); antenna patterns read off vendor PDFs
  into the coverage model, labelled as read by eye.
- Install photos are filed as evidence: kept UNCHANGED,
  with sha256 and EXIF provenance in an index file. Camera
  GPS error (12–15 m) is recorded, and the photos are NOT
  used as precise equipment pins (collected:
  earlier field runs). Photos say what the records
  cannot: "the wAP is at the window, facing the street"
  settled a coverage question no router reading could.
- Prescribed but pending: U2 install-photo check (photo of
  the wiring checked against the install sheet — a natural
  SAM job with no credentials in frame, DESIGN); U3 siting
  from a panorama (hand-written skyline mask JOURNALED,
  SAM segmentation DESIGN; keep GPS out of public frames);
  vendor-PDF digitizing done carefully — cite the page,
  keep variants separate, never digitize a curve into false
  precision (collected: earlier field runs).
- Demo rules for every published frame: no names, places,
  addresses, or serials; strip EXIF GPS from photos
  (collected: presentation rules from earlier field runs). pre-publish-scrub
  gates any public step.
- Boundary with field-sheets: the install SHEET the photo is checked
  against, and any field checklist the photo completes,
  belong to field-sheets. This skill owns filing (unchanged bytes +
  hash + EXIF index + recorded GPS error) and the
  photos-are-not-pins rule.

### 4. Correct (Fix GPS — MAP half of human-correction-roundtrip)

- Fix-GPS mode: the owner drags existing pins or adds
  points; edits persist in browser localStorage; the page
  copies structured TOML-like corrections (original
  position + movement distance) to paste to the agent, and
  exports KML for Google Earth inspection. When
  regenerated data already contains a correction, the page
  clears the corresponding local edit within a small
  tolerance (collected: an earlier design review and field runs).
- This is the human → artifact → agent → structured-record
  loop: the human supplies spatial judgment through a map;
  the agent handles file editing and propagation — no
  TOML, no paragraphs-of-chat location descriptions
  (collected: the concept review). Demo beat O3: a
  correction flows back (Fix-GPS loop JOURNALED; needs the
  portable "copy for your agent" wording — it names a specific agent
  today).
- Limits, all load-bearing (collected: the concept review):
  browser-local edits are NOT synchronized inventory
  updates; copying a correction is NOT proof the agent
  applied it. Required additions: a revision identifier
  and a visible proposed / applied-to-inventory / published
  distinction, especially when old pages remain open.
- Observed (self-test fixture): draggable SVG markers,
  localStorage keyed by revision, "Copy correction for
  your agent" button emitting `device=… original_lat=…
  original_lon=… new_lat=… new_lon=… moved_m=…
  status=proposed revision=…` lines, corrections-KML
  download, and sub-meter-drag tolerance clearing. The
  page pattern is proven; a live owner round-trip is
  pending.
- Boundary with field-sheets: generalizing the pattern to
  port-label corrections, "this device is in the other
  room", proposed cable routes, and field-observation
  checklists (collected proposal: the concept review) is
  field-sheets' content design. This skill owns the map-loop
  mechanics: drag → structured proposal → agent applies →
  regenerate → published. field-sheets stays listed.

## Part 2 — Skill doc

### Trigger

Load when: mapping device positions or RF coverage; rendering
a setup sheet or annotated-map image; filing install or site
photos as evidence; accepting a location/label correction
from the owner; asking which artifact fits the person looking
(present-it table: the presentation rules). (Entry-skill +
capability-probe pattern.)

### Prereqs

- Records with positions (KML truth or site records) + a
  `gis` block per site (layer URLs, fields, source labels).
- A render machine with a headless browser for the PNG path
  (`chromium` observed on a Linux host; `test.sh` also accepts
  `google-chrome` / `chromium-browser`).
- Bun + python3 for the reference generator and self-test.
- Know which harness the artifact must suit (harness-capability-inventory
  → presentation-layer keying, both pending): phone-thread
  PNG, printable HTML, live page, or chat-inline image.

### Access

- Pure local render: NO twin, NO box writes, NO router
  contact. Safe anywhere, including beside production.
- Maps are the most location-revealing workspace artifact:
  parcel fields exclude owner names; GIS cache stays
  local-only (never a public repo); blur maps in public
  video; strip EXIF GPS before any public frame.
- Photos filed as evidence keep original bytes + sha256 +
  EXIF index; the index, not the photo, carries the
  provenance claims.

### Envs

| Name | Use |
|---|---|
| `CHROME` | Optional override for the headless browser binary (`test.sh` probes `chromium`, `google-chrome`, `chromium-browser` when unset) |

No secrets, tokens, or API keys in env for this skill — map
and GIS sources here are public-data endpoints, and no
credentialed door is part of the render path.

### Outputs

- Generated site-map page (one per site, revisioned,
  source-labelled, never hand-edited).
- KML truth (round-trips through Google Earth; corrections
  back in the same format).
- 1080×1350 PNG pages (phone thread) + print HTML from the
  same records.
- Photo evidence index (sha256 + EXIF provenance +
  recorded GPS error per photo).
- Structured corrections (`device/original/new/moved_m/
  status=proposed/revision`) + applied/published status.

### Verification

- Regeneration check: same records → same page (revision
  id stable); a correction applied + regenerated clears
  the matching local edit within tolerance.
- Honesty labels present: "A sketch, not a survey" on
  coverage; source label per layer; capture/generated
  date; proposed vs applied vs published on corrections.
- KML round-trip: parses as XML; Placemark count and
  coordinates match the records (self-test asserts this).
- PNG check: exactly 1080×1350 and non-blank (self-test
  asserts via `check-png.py`).
- Privacy audit: no owner names in parcel fields, no
  EXIF GPS in published frames, no real places in
  fixtures, GIS cache outside any public tree.
- Claim audit: each map claim carries command + output or
  an honest collected/inferred/pending label.

### Recovery

- Render disagrees with the records → re-generate first
  (stale render is the common case); the records win.
- Correction disputed → it stays `proposed` until the
  agent applies or rejects it with a reason; downgrade
  beats deletion (the question stays visible).
- Tile/GIS endpoint unreachable → show last-good cached
  box with its capture date + source error; never swap in
  a different area silently (last-good-data rule:
  the concept review).
- Secret or real location leaked into a shared artifact →
  delete the artifact, scrub per pre-publish-scrub, record as an
  anomaly (evidence-ledger precedent).
- Browser missing on a new machine → install Chromium or
  equivalent; the `?p=N` + screenshot primitive does not
  change.

### Limits

- No live-record render has been exercised in this lane
  yet: the self-test proves the pipeline on synthetic
  fixtures; first real-records map + live tile/GIS fetch
  is pending (sandbox egress probes open).
- No live owner round-trip yet: Fix-GPS page mechanics are
  proven in the fixture; a real drag → paste → apply →
  regenerate → publish cycle is pending.
- U2/U3 vision steps (SAM install-photo check, SAM skyline
  segmentation) are DESIGN, not proven; the journaled
  panorama fit used a hand-written mask.
- This skill covers GEO maps (positions, coverage, GIS,
  KML, PNGs). Logical topology is truthful-topology-graphviz (DOT→SVG,
  observed/inferred marking) — neither geo nor RF
  coverage graduates through that pipeline. Topology views
  of multi-AP sites are site-plan-multi-ap (Leaflet is
  NOT the useful view there). Outdoor link data (Starlink,
  LiDAR beyond hillshade, property lines, solar) extends
  via pending maps-outdoor. Whiteboard content is decision-board-lifecycle;
  WebFig deep links are webfig-handoff; harness keying is harness-capability-inventory/presentation-layer.
- Field-sheets content (field-sheets, pending) is the standing
  companion: device jobs, aiming, expected-result and
  stop-condition sheets. This skill's render/file/loop
  halves plug into it; they do not replace it.
