---
name: presentation-layer
description: "Render findings as the artifact each harness can actually show: key off the harness-capability matrix, pick by the present-it table, generate from records, verify honesty labels. Use when: reporting status, coverage, or options to the owner; choosing between a page, PNG, link, or whiteboard; or asking why a visual did or did not render in a harness."
topics: [presentation, visualization, owner-ux]
tested: self-test
---

# `presentation-layer` skill (matrix → pick → render → verify → deliver) [template v1 draft]

The standing rule: agents
surface findings as visuals suited to the PARTICULAR
harness, never multi-paragraph essays by default. This
skill is the decision procedure; the evidence it keys off
is `harness-capability-inventory`'s matrix (observed /
collected / pending per cell, dated). No matrix row, no
presentation choice — a format picked without a row
behind it is a guess. The reference renderer
(`references/render-views.py`) proves the pipeline on a
synthetic findings fixture: self-contained HTML + SVG
board + 1080×1350 PNG + WebFig link list. No twin, no
box writes: local render only.

## Part 1 — The checklist (keyed, never guessed)

Run top to bottom. Every artifact regenerates from the
records — hand-editing a delivered visual is forgery.

1. Read the target harness's matrix row (harness-capability-inventory): which
   surfaces are observed-yes, and is the row a rumor
   (>~30 days)? (step 0).
2. Pick the artifact by the present-it table: who is
   looking × what they do next (step 1).
3. Render from records via the reference renderer (or
   the owning skill's generator): HTML/SVG/PNG/links,
   offline-safe (step 2).
4. Verify: honesty labels, offline purity, dimensions,
   privacy (step 3).
5. Deliver to the harness's evidence channel; on render
   failure demote the matrix cell, do not retry blind
   (step 4).

### 0. Key (read the matrix row first)

- Load `harness-capability-inventory` and read the ONE
  row for the harness in front of you. Observed-yes
  cells are your allowed surfaces; pending cells are
  NOT fallbacks — a pending surface means "pick a
  different artifact", never "try it and hope".
- Matrix v1 cells this skill leans on (collected:
  the capability matrix, 2026-10-30): a local workstation serves loopback pages
  + generates images (observed) but inline display in
  the owner's UI is pending; sandboxed agents have no loopback
  from the sandbox browser (collected) with Issues +
  Drive .md as evidence channels; T3/Meta/plain-chat
  rows are near-blank pending — route those through
  file/PNG artifacts until probed.
- Rumor rule (collected: the harness-matrix step 4): a matrix older
  than ~30 days is a rumor. Keying off a rumor is
  allowed only if the delivery says so ("matrix 45
  days old — re-probe if this fails to render").
- Observed (this skill's self-test): the fixture
  carries `matrix_date`, and every rendered view
  prints it — the keying is visible on the artifact,
  not just in the agent's head.

### 1. Pick (the present-it table)

Collected OPINION (the template's
standing rule, adopted here): pick the artifact by who's
looking and what they need to do next.

| Who / what | Artifact | Must include |
|---|---|---|
| Person on site, doing physical work | Setup sheet PNG pages (map-reports render primitive; field-sheets content) | Labels, ports, direction in words, "how to tell it worked", "if not, stop and send a photo" |
| Owner deciding between options | Whiteboard page or screenshot (decision-board-lifecycle) | Answer first, options, what the test showed, what it can't show, estimates marked |
| Owner asking "where / what covers what" | Site map page or image (map-reports) | Source labels per layer, "estimate" on coverage, capture date |
| Owner asked to check/change one thing | WebFig deep link (webfig-handoff) | Router name, the page, what to look at |
| Remote diagnosis | Readings with provenance | Timestamps, which box, which reads failed |
| Owner correcting the agent | Page emitting structured correction (Fix-GPS pattern, map-reports §4) | Original value, new value, proposed vs applied |

- Status dashboards ("are things up?") route to
  container-render-surface when a live surface exists,
  else to this skill's static board (HTML + PNG).
  Topology questions route to truthful-topology-graphviz (DOT→SVG), never to
  a generated-pixels diagram (collected: the platform tooling
  explainer — generator pixels are
  unverifiable, never the source of a topology claim).
- Multi-AP layout questions route to site-plan-multi-ap (Leaflet is
  NOT the useful view); outdoor-link context routes to
  maps-outdoor. This skill picks those skills' artifacts; it
  does not re-render their domains.
- Essay fallback: when NO visual surface is observed
  for the harness (plain-chat row today), a short
  structured text (answer first, then findings table,
  then gaps) is the honest artifact — still never a
  multi-paragraph essay by default.

### 2. Render (records in, views out)

- Render via the OWNING skill's generator where one
  exists (map-reports build-map.ts, decision-board-lifecycle board fragment,
  truthful-topology-graphviz DOT pipeline) — this skill's reference renderer
  covers only the generic status board + link list,
  the artifact with no other owner.
- Observed (self-test): `references/render-views.py`
  takes a findings fixture and emits four views —
  `views-local.html` (self-contained, inline CSS, no
  external refs, no script), `views-board.svg`
  (hand-built 1080×1350 status board), `views-board.png`
  (headless-chromium screenshot of the inlined SVG,
  same flags as map-reports' proven PNG path), and
  `views-links.md` (harness routing table + WebFig
  deep links against `router.invalid`, never a real
  host). The test renders fully offline into a temp dir.
- Every view prints: what it is, generated UTC time,
  matrix date keyed off, and SYNTHETIC when from a
  fixture. Undated, unkeyed views are rumors with
  pixels.
- Pending: first render against REAL findings (not the
  fixture) + a live-harness display check (the harness-matrix
  UI-level probe this pipeline cannot run alone).

### 3. Verify (before anything reaches the owner)

- Honesty labels present: generated time, matrix date,
  "estimate" on any modeled number, proposed-vs-applied
  on anything awaiting action. Observed: the test
  greps every label onto every view.
- Offline purity: the HTML view carries no external
  refs and no script (test asserts `http`, `fetch(`,
  `XMLHttpRequest`, `<script` all absent); the SVG
  parses as XML; the PNG path needs only a local
  chromium.
- PNG check: exactly 1080×1350 and non-blank (same
  `check-png.py` pattern as map-reports, vendored copy in
  references/; threshold 32 unique colors for the
  simpler board).
- Privacy audit: fixtures synthetic + documentation
  hosts only (`router.invalid`); no real site names,
  addresses, serials, or credentials on any view; maps
  blurred per map-reports before any public frame; pre-publish-scrub gates
  any public step.

### 4. Deliver (to the evidence channel, then record)

- Deliver to the harness's matrix-listed evidence
  channel: local workstation → local files + handoff-note pointer; sandboxed
  agents → Issue or Drive .md in place (collected: the harness matrix);
  unprobed harnesses → file/PNG handoff + a note that
  the channel is assumed, not observed.
- On render/display failure: STOP and demote. Per harness-matrix
  recovery, a green matrix cell that fails to render
  lied — reproduce, demote to pending with the failure
  output, note it in an `inbox/` handoff, re-probe. Never retry the
  same surface twice without new evidence.
- Record the delivery per `evidence-ledger`: which
  view, which harness, matrix date keyed off, and
  whether the owner confirmed seeing it (unconfirmed
  delivery is pending, not done).

## Part 2 — Skill doc

### Trigger

Load when: reporting anything to the owner; choosing a
presentation format; asking "can the owner SEE this
here"; debugging a visual that failed to render; or
adding a harness row that harness-capability-inventory just probed.

### Prereqs

- `harness-capability-inventory` matrix read (know the
  row + its date + which cells are rumor).
- Findings with provenance (readings carry timestamps
  + box + failed-reads, per the present-it table).
- Bun/python3 + chromium + dot for the reference
  renderer and self-test (stdlib only + local tools).

### Access

- Pure local render: NO twin, NO box writes, NO router
  contact. Safe anywhere, including beside production.
- Views are owner-safe by construction (synthetic
  fixtures, documentation hosts) until real findings
  flow through — then pre-publish-scrub + the step-3 privacy audit
  gate every delivery.

### Envs

| Name | Use |
|---|---|
| `CHROME` | Optional override for the headless browser binary (`test.sh` probes `chromium`, `google-chrome`, `chromium-browser` when unset) |

No secrets, tokens, or API keys — no credentialed door
is part of any render path here.

### Outputs

- The picked artifact (HTML page / SVG / 1080×1350 PNG
  / link list / whiteboard screenshot / short text),
  dated + matrix-keyed + honesty-labeled.
- A delivery record (view, harness, matrix date,
  owner-confirmed or pending).
- On failure: a matrix demotion (pending cell +
  failure output + handoff note), never a silent retry.

### Verification

- Matrix row cited with date; rumor rows flagged on
  the delivery when keyed off.
- Present-it table row named for the pick (who × next
  action); essay fallback justified by the row, not
  by laziness.
- Render checks green (labels, offline, dimensions,
  privacy) — self-test asserts the mechanical half.
- Delivery recorded per evidence-ledger with owner
  confirmation state explicit.

### Recovery

- Matrix cell lied (render/display failed) → demote
  to pending with failure output + handoff note (see
  step 4). The cell, not the renderer, is the suspect.
- No observed surface for the finding kind → fall
  back one rung (live page → PNG → short text) and
  say so on the artifact.
- Chromium missing on a new machine → install it (or
  equivalent); the screenshot primitive does not change.
- Fixture/output mismatch → regenerate first; records
  win over renders, always.

### Limits

- This skill routes and renders generic boards; domain
  artifacts belong to their skills (map-reports maps,
  decision-board-lifecycle boards, truthful-topology-graphviz
  topology, site-plan-multi-ap layouts, webfig-handoff links). It
  picks them, never rebuilds them.
- No live-harness display check exists yet: the PNG
  mechanism is proven locally, but sandbox-PNG-inline
  and phone-thread delivery are pending day-0 probes
  (collected from earlier field runs, via map-reports).
- The present-it table is adopted OPINION, not measured
  UX — the first owner who misunderstands a picked
  artifact overrules the table; record the correction.
- Essay fallback is a floor, not a license: two
  consecutive text fallbacks for the same harness is
  a probe-the-harness task (harness-capability-inventory), not a style.

## Showing things to the owner (Mode B)

- Write self-contained HTML/SVG/PNG into the workspace
  (`reports/` preferred); the owner opens them framed.
- Everything inline: outside fonts, scripts, images and
  fetches are blocked. Navigation can't be *prevented*
  (no navigate-to), only detected and stopped.
- Residual: a navigation before the file finishes loading
  can escape detection, and the first request still goes
  out — no navigation is the contract.
- Static by default: scripts run only via Run scripts or
  the render jobs (topology, report).
