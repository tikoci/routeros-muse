---
name: truthful-topology-graphviz
description: "Render network topology from observed reads, not pixels: centrs reads to deterministic DOT to SVG, observed and inferred links marked separately, regenerated after every change to show the diff. Use when: drawing what connects to what, proving a topology claim, diffing the network before and after a change, or reviewing whether a diagram is truth or illustration."
topics: [topology, graphviz, visualization, verification]
tested: none
---

# `truthful-topology-graphviz` skill (read → emit → mark → render → polish) [template v1 draft]

Promoted from the platform tooling explainer's Topology pipeline
(Spark reads actual topology → DOT → SVG), the
observed/inferred rule, and the standing Image-vs-Graphviz
correction. Distinct from map-reports (geo maps — where
sites sit) and a feed into presentation-layer (presentation keyed to harness).
v3 TOOL AGNOSTIC: DOT is used here for prior art + availability
(`dot` 16.1.0 observed on a Linux host), but mermaid or
TOML-to-SVG are equally fine — the load-bearing part is visual
presentation of observed data, not the renderer. Core rule:
Graphviz for topology, Image for polish. No secrets below;
renders carry shapes and labels, never credentials.

## Part 1 — The checklist (every edge cites a read)

Run top to bottom. A topology render is done when every node
and edge traces to a read, inferred links are visibly
inferred, and the render regenerates after the next change.

1. Read the actual topology (§0): centrs reads of
   interfaces/bridges/routes/neighbors, twin or real router.
2. Emit deterministic DOT (§1): generator output, fixed layout,
   no hand-drawn edges.
3. Mark observed vs inferred (§2): separate styles, mandatory
   legend, inferred never graduates silently.
4. Render + regenerate diffs (§3): SVG truthful by
   construction, revisioned, re-rendered after every change.
5. Polish without lying (§4): Image around the truth, never as
   its source.

### 0. Read (the router is the source, not the sketch)

The pipeline's first stage (collected: the platform explainer):
Spark reads the ACTUAL topology — centrs reads of
interfaces/bridges/routes on the real router, or the quickchr
twin — and only then emits DOT. No read, no diagram.

Observed `centrs retrieve` shape (0.1.9-next, this session):

```text
Usage: centrs retrieve <target> <routeros-path> [flags]
  --attributes <a,b> / --all-attributes   project columns
  --query <expr>                           router-side row filter
  --format json                            structured envelope
  --quickchr <name>                        twin target
  --group <name> / --all                   fan-out
```

- Topology menus live under `/interface`, `/ip/route`,
  `/ip/neighbor`, bridge and wireless tables — read with
  `--attributes` projection + `--format json` so the generator
  consumes envelopes, not prose. Fan-out (`--group`/`--all`)
  covers multi-router topologies; `--quickchr` aims the same
  reads at a twin.
- Each node and edge cites its read: menu path + target + date.
  The same reads feed state-pull (captures) and
  service-path-fleet-check (per-device outcomes) — one
  observation, several consumers.
- What the reads cannot see (radios, hardware equivalents,
  traffic) stays out of the render or enters as inferred (§2):
  a CHR is not automatically equivalent to the target's radios,
  hardware, topology, or traffic (collected: the concept review).

### 1. Emit (deterministic DOT, generator-written)

- DOT it is (collected: the platform explainer): deterministic
  layout, MikroTik palette — the forum Graphviz skill is the
  prior art. The generator emits DOT from read envelopes; no
  hand-added nodes, no eyeballed links. Deterministic input →
  deterministic layout: the same reads always draw the same
  graph.
- `dot` 16.1.0 observed on a Linux host (`dot -V`):
  render is `dot -Tsvg`, available on the build machine. First
  twin-read render in this lane is still pending — claimed as
  available tooling, not as an exercised pipeline.
- Tool-agnostic clause: DOT is fine for
  stored flows (agent-readable + renderable); mermaid or
  TOML-to-SVG are equally fine. If a harness in presentation-layer's inventory
  renders one better, switch the emitter — the reads and the
  observed/inferred discipline (§2) do not change.

### 2. Mark (observed solid, inferred dashed, legend always)

- The rule (collected: the concept review): deterministic
  diagram rendering does NOT validate inferred topology. Mark
  observed and inferred links SEPARATELY — solid vs dashed
  (or equivalent), with a legend on every render. A render
  without a legend is illustration, not evidence.
- Inferred sources, honestly labeled: rack/closet photo → SAM
  segmentation → Spark draft → Graphviz (optional secondary
  use, never a dependency — collected: the platform explainer);
  vendor-PDF antenna patterns read by eye (label as read by
  eye, cite the page, keep variants separate, never digitize a
  curve into false precision — collected: earlier field runs
  + rosetta reference); phone-GPS pins (12–15 m camera error
  recorded; photos NOT used as precise equipment pins —
  collected: earlier field runs).
- Inferred never graduates silently: a dashed edge becomes
  solid only when a read confirms it, and the confirming read
  is cited like any other. Regeneration preserves the marking
  until then.

### 3. Render (SVG by construction, diffs by regeneration)

- The rendered SVG is truthful BY CONSTRUCTION: it can only
  show what the reads contained, and it regenerates after
  every change to show the diff (collected: the platform
  explainer). The diff — before-render vs after-render — is
  the verification artifact for topology-changing work.
- Every render carries a revision identifier + generated time
  (+ source-read citations per §0). Old renders are kept (or
  the diff is unprovable): the render at decision time is what
  the decision cites, not "the current view".
- State the reload semantics; do not guess (collected: the concept
  review's table — different edits publish differently).
  Who re-renders, on what trigger, and where the fresh SVG
  lands belong in the recipe that uses this skill.
- Delivery follows the presentation rules: renders land
  where the owner reads — dashboard, whiteboard (decision-board-lifecycle), or PNG
  screenshot into chat (1080×1350 portrait precedent,
  the presentation rules). The SVG is the truth; the PNG is the
  postage.

### 4. Polish (Image around truth, never as truth)

- What Image is good for (collected: the platform explainer):
  the presentation layer — polished hero visuals, stylized
  before/after illustrations, wiring-closet photo cleanup.
  $0.01/image on the same Model API key.
- What it is NOT: a diagramming engine. It renders pixels, not
  data — labels, addresses, port numbers, and link
  relationships in a generated "topology diagram" can be
  subtly wrong, and you cannot diff or verify it. For a
  project whose brand is verified-not-guessed, an
  unverifiable diagram is off-message (collected: the platform
  explainer + the agent-feedback correction, which stands).
- The correction is part of the record: the explainer's own
  author corrected "Muse Image for topology" to "Graphviz for
  topology, Muse Image for polish" — cite the corrected form,
  and correct anyone quoting the uncorrected pitch (collected:
  the platform explainer).
- Polish never touches topology claims: Image may frame, crop,
  or beautify AROUND a Graphviz render; the nodes, edges, and
  labels inside the frame come from §0–§3 only.

## Part 2 — Skill doc

### Trigger

Load when: drawing what connects to what; proving a topology
claim; diffing the network before/after a change; reviewing
whether a diagram is truth or illustration; "can Image draw
our network" questions (answer: no — §4). (Entry-skill +
capability-probe pattern.)

### Prereqs

- centrs on PATH at a known version (retrieve shape here
  observed at 0.1.9-next) + a reachable target (twin or
  router) with read rights.
- A DOT renderer on the render machine (`dot` 16.1.0 observed
  on a Linux host) — or the presentation-layer-keyed alternative stated up front.
- The reload/render recipe that will consume the SVG (who
  re-renders, on what trigger, where it lands).

### Access

- Reads-first: topology reads are plain reads — free on test
  boxes; production reads follow the standing read posture.
- Renders are derived artifacts: they inherit the scrub of
  their sources (state-pull redaction, pre-publish-scrub
  before any public step).
- Never render credentials, serials, or private addresses
  into a shared or published diagram — shapes and role-labels
  outside the trusted circle.

### Envs

| Name | Use |
|---|---|
| `CENTRS_CDB_FILE` | CDB allowlist path for retrieve targets |
| `CENTRS_CDB_PASSWORD` | Decrypt password for an encrypted CDB |

No render credentials or API keys in env for topology
purposes. Image-polish keys (if any) live in the deployment's
own store, never in the repo.

### Outputs

- Read envelopes (menu + target + date per node/edge).
- Deterministic DOT (generator output, checked in or
  reproducible from the reads).
- Revisioned SVG + legend + generated time.
- Before/after render pair for topology-changing work.
- Pending list: unconfirmed inferred edges with owners.

### Verification

- Every node/edge traces to a cited read; spot-check two by
  re-running the read.
- Observed vs inferred marking present + legend on the
  render; no dashed edge without an owner for confirmation.
- Regeneration check: same reads → same graph (byte-compare
  the DOT, eyeball the SVG).
- Diff check: the after-render shows the change and only the
  change; unrelated drift is flagged, not absorbed.
- Claim audit: each topology claim carries command + output
  or an honest collected/inferred/pending label.

### Recovery

- Render disagrees with the router → re-read first (stale
  render is the common case); the reads win, always.
- Inferred edge disputed → it stays dashed until a read
  settles it; downgrade beats deletion (the question stays
  visible).
- Renderer missing on a new machine → install `dot` or invoke
  the §1 tool-agnostic clause with the substitute named and
  the discipline unchanged.
- Secret rendered into a diagram → delete the render, rotate
  if live, record as an anomaly (evidence-ledger precedent).

### Limits

- No twin-read render has been exercised in this lane yet:
  `dot` availability is observed, the end-to-end pipeline is
  pending its first run.
- The forum Graphviz skill (MikroTik palette, layout
  conventions) is collected prior art, not re-read here —
  re-verify its shape before quoting details.
- Photo-derived topology (SAM → draft) is speculative
  garnish: nice if a spike works, never a dependency.
- This skill covers logical topology (links, paths,
  neighbors). Geo maps are map-reports; RF coverage is antenna-pattern
  inference (§2) — neither graduates through this pipeline.
- Harness keying (presentation-layer inventory) may move the renderer —
  quoted as pending until presentation-layer lands.
