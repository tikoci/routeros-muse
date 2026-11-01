---
name: maps-outdoor
description: "Plan outdoor links with the data indoor maps lack: Starlink context, LiDAR terrain, property-line parcels, and off-grid solar — as new KML layers and page overlays on the map-reports pipeline. Use when: siting a point-to-point link, checking sky view or sun hours, laying a link across parcels, or asking what terrain says about a coverage complaint."
topics: [maps, outdoor, lidar, solar, gis]
tested: self-test
---

# `maps-outdoor` skill (link question → outdoor layers → page + KML → verify) [template v1 draft]

Extends map-reports (read that skill
first): map-reports owns the site-map page, the KML-truth
discipline, and the PNG path — THIS skill adds only the
OUTDOOR data sources an indoor map never carries:
Starlink context, LiDAR terrain, government parcel
lines, and solar data for off-grid sites. It consumes
map-reports's pattern (own fixtures, own builder, own test) and
never edits map-reports. Geo maps live here + map-reports; logical
topology is truthful-topology-graphviz; multi-AP site views are site-plan-multi-ap. The
reference builder proves the pipeline on synthetic
fixtures (null-island coords, never a real place). No
twin, no box writes: local render only.

## Part 1 — The checklist (link question first, layers second)

Run top to bottom. Layers without a link question are
wallpaper — the question decides which layers load.

1. Name the link question: which link/site, what
   decision it gates (step 0).
2. Source the outdoor layers with per-layer source
   labels + capture dates (step 1).
3. Build the outdoor page on map-reports's page shape (step 2).
4. Emit KML truth for outdoor features (step 3).
5. Verify honesty labels + privacy, then file (step 4).

### 0. Name the link question (the only branch)

- The four outdoor questions (one per data source):
  (a) Starlink context — is there usable sky, what
  obstructs, where does the dish live; (b) LiDAR
  terrain — do ridges/gullies/tree lines break the
  radio path (collected via map-reports
  — hillshade shows what satellite hides, and that
  decides where a link works); (c) parcels — whose
  land the link crosses, where the property lines run
  (built once, reused); (d) solar — winter-sun hours
  at an off-grid site (collected precedent: a
  panorama-to-LiDAR fit that recovered sun hours; see
  map-reports §3).
- Record the question + the decision it gates ("link
  A→B on 5 GHz: go/no-go by Friday") before loading
  any layer. Unasked layers stay off — a page with
  every layer on answers nothing.
- Observed (self-test fixture): one 2.1 km link
  question with all four layers present, each labeled
  with source + planning-grade honesty marking.

### 1. Source (the four outdoor layers)

- Starlink context: obstruction/sky-view notes for the
  dish site + where the dish uplink enters the
  network. This skill holds dish-placement context,
  not Starlink performance claims (no throughput
  promises from a map).
- LiDAR terrain: USGS 3DEP hillshade background
  (collected from earlier field runs) + any local DEM
  hint for the path profile. Hillshade is for READING
  terrain (ridges, gullies, tree lines), not for
  numbers — path-loss math says what it is or stays out.
- Parcels (government data): county ArcGIS REST
  FeatureServer parcels with NO owner names (same
  rule as map-reports §0), roads, built once per site and
  cached. Parcel fields are allow-listed (geometry +
  line labels); everything else is dropped at fetch.
- Solar: winter-sun hours per candidate off-grid spot
  + panel/azimuth notes. A single number per spot
  ("3.1 h Dec") beats a heatmap nobody reads; the
  method behind the number rides along or the number
  does not ship.
- Every layer carries: source label, capture/fetch
  date, and grade (measured vs read-by-eye vs
  inferred). Fetched features cache by bounding box
  per map-reports §0 — a small correction does not refetch.

### 2. Build (the outdoor page — map-reports's shape, new layers)

- One generated HTML page per site, same contract as
  map-reports §1: regenerated from records, never hand-edited,
  layers toggleable, records on top, honesty labels
  on. The outdoor layers render as overlay sections
  with per-layer source footers — the page this skill
  builds proves the overlay pattern, not a tile stack.
- Observed (self-test): `references/build-outdoor.py`
  generates a self-contained page from the synthetic
  fixture — four layer sections (starlink/lidar/
  parcels/solar), each with source + date + grade, a
  link-question header, and the "planning sketch, not
  a survey" label. Fixture mode makes zero
  page-initiated network requests.
- Present-it rule for this artifact (see presentation-layer): owner asking "will
  this link work / where does the dish go" gets the
  outdoor page or a single image of it, with source
  labels per layer and a capture date.
- Pending: first render against real records + live
  endpoints (ArcGIS parcels, USGS hillshade tiles,
  Starlink obstruction tooling) — same sandbox-egress
  probes map-reports lists, plus a parcel-field
  allow-list review on first real fetch.

### 3. Emit (KML truth for outdoor features)

- Same KML discipline as map-reports §0: positions the owner
  can open in Google Earth with no new app; Fix-GPS
  corrections back in the same format. Outdoor
  additions: link-path LineStrings (endpoint to
  endpoint), dish/spot Placemarks per layer (sky-view
  spot, sun-hour spot), parcel-line overlays by
  reference (geometry stays in the cache, KML points
  at it — never bloat KML with parcel polygons).
- Observed (self-test): builder emits KML with one
  Placemark per fixture feature + one LineString for
  the link path; the test parses the KML, counts
  Placemarks against the fixture, and matches the
  link coordinates exactly.
- Coordinates in fixtures are null-island synthetic
  (lat/lon near 1.0, labeled SYNTHETIC) — a fixture
  that looks like a real place is a privacy accident
  waiting to happen.
- Pending: KML round-trip through actual Google Earth
  (parse-validity is proven; app behavior is not).

### 4. Verify + file (labels, privacy, then records)

- Honesty labels present on page AND KML description:
  "planning sketch, not a survey" on terrain/solar
  reads; source + date per layer; grade per number
  (measured/read-by-eye/inferred). Self-test greps
  every label.
- Privacy audit (load-bearing — parcels are the most
  sensitive layer here): no owner names in parcel
  fields (self-test asserts `owner_name` absent from
  every output); no EXIF GPS in published frames;
  fixtures synthetic-only; GIS/parcel cache stays
  local-only, never a public repo (same rule as map-reports).
- Offline purity: fixture page carries no external
  refs, no fetch/XHR (self-test asserts); live
  endpoints enter only in real-record mode with a
  capture date.
- File per `evidence-ledger`: the link question, the
  layer sources + dates, the verdict given, and what
  would change it. Map corrections flow back through
  map-reports's Fix-GPS loop; this skill adds no second loop.

## Part 2 — Skill doc

### Trigger

Load when: siting or judging an outdoor link; checking
dish sky view or off-grid sun hours; laying a link
across parcels; asking what terrain says about a
coverage complaint; or extending a map-reports site map with
outdoor context.

### Prereqs

- map-reports read (page contract, KML discipline,
  PNG path, Fix-GPS loop) — this skill assumes it.
- The link question written down (step 0) before any
  layer loads.
- Bun/python3 for the reference builder and self-test
  (python3 stdlib only — no deps).

### Access

- Pure local render: NO twin, NO box writes, NO router
  contact. Safe anywhere, including beside production.
- Parcel layer is allow-listed fields only; the cache
  is local-only. Real-place renders get the map-reports blur
  treatment before any public frame; pre-publish-scrub gates public steps.

### Envs

| Name | Use |
|---|---|
| (none) | No env knobs — the builder takes `--fixtures` + `--out` flags |

No secrets, tokens, or API keys — outdoor sources here
are public-data endpoints plus local terrain reads.

### Outputs

- Outdoor page (one per site, layered, source-labeled,
  never hand-edited) + print/PNG via map-reports's primitive.
- Outdoor KML (feature Placemarks + link LineStrings,
  Google-Earth-openable).
- Per-layer source record (source, date, grade) filed
  with the link verdict.

### Verification

- Link question on the page, decision + date named.
- Source + date + grade per layer; "planning sketch,
  not a survey" on terrain/solar reads.
- KML parses; Placemark count + link coords match
  fixtures (self-test) or records (real mode).
- Privacy audit green: no owner names, no real-place
  fixtures, cache local-only.
- Claim audit: each outdoor claim carries command +
  output or an honest collected/inferred/pending label.

### Recovery

- Layer source unreachable → last-good cached box with
  its capture date + source error; never swap areas
  silently (map-reports Recovery rule).
- Parcel fields leak owner data → drop the layer,
  re-allow-list, scrub per pre-publish-scrub, record the anomaly.
- Page disagrees with records → regenerate; records win.
- Correction from the owner → map-reports Fix-GPS loop; no
  second loop here by design.

### Limits

- No live-endpoint render yet: pipeline proven on
  synthetic fixtures; ArcGIS/USGS/live-sky first
  fetch is pending with the egress probes open.
- Planning-grade only: hillshade reading and
  read-by-eye sun hours are sketches, not surveys —
  the label is the load-bearing part.
- Dish-performance claims are out of scope (placement
  context only); RF path-loss math stays out unless
  it says exactly what it is.
- Indoor site maps stay map-reports's; this skill's page is
  the outdoor overlay, not a second map system.
