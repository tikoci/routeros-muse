---
name: anonymized-pattern-extraction
description: "Mine a private repo for generic patterns with zero private specifics: shape-not-detail extraction, labeled claims, synthetic examples, scrub-gated handoff. Use when: learning from a private workspace, writing up lessons from a network you cannot show, reviewing whether a write-up leaks, or asking what may travel from private to shared."
topics: [privacy, patterns, extraction, documentation]
tested: none
---

# `anonymized-pattern-extraction` skill (scope → extract → label → gate) [template v1 draft]

Promoted from the coding-agent brief's extraction assignment
(pattern only, shape-not-detail), its executed precedent (the
brief → feedback-doc pipeline that actually ran), the concept
review's carry-across rule, and the standing privacy lines.
Backlog #46. Pairs with #31 (pre-publish-scrub): extraction
produces the doc, #31 gates its publication. Core rule: carry
across MEANING — never private inventories, addresses,
credentials, topology, code, or deployment-specific
assumptions. No secrets below; this skill shows shapes of
shapes.

## Part 1 — The checklist (nothing private travels)

Run top to bottom. Extraction is done when the write-up teaches
everything the private repo taught you and contains nothing an
owner would flinch to see quoted.

1. Scope the extraction (§0): assignment shape, what is wanted,
   what is forbidden.
2. Extract shapes, not details (§1): patterns, lessons, failure
   modes — every private value replaced by its shape.
3. Label every claim (§2): VERIFIED / JOURNALED / OPINION +
   house style, contradictions named.
4. Gate and hand off (§3): synthetic examples, self-review,
   #31 scrub, delivery.

### 0. Scope (the assignment, quoted)

The brief's assignment, verbatim in spirit (collected: brief
for coding agent § assignment): mine the private repo for
GENERIC ideas — how tools were wired together, the auth scheme
it used, what broke, what worked, what you would reuse — and
write the PATTERNS AND LESSONS into the shared folder.
Patterns only: no private code, names, addresses, credentials,
or topology specifics. If a lesson depends on a private
detail, describe its SHAPE, not the detail.

- Wanted output (collected: brief "What to produce"):
  architecture shape, auth scheme, failure modes, reuse-or-
  avoid judgments; feedback on the live design from the
  private vantage point; story-vs-results flags; test results
  with exact commands + full outputs, habitat labeled.
- Forbidden cargo (collected: concept review §carry-across +
  muse-feedback privacy line): names, places, addresses,
  serials, credentials, topology, private code, deployment-
  specific assumptions. Public repo URLs and skill names only.
- The executed precedent (collected: the brief ran): the
  "Coding Agent Feedback" doc EXISTS — a private-network
  operator read the brief, mined their repo, and delivered
  patterns + feedback + flags + tests with the labels below.
  Extraction is a proven pipeline, not a proposal.
- Scope edge: a lesson that cannot survive without its
  private detail does not travel — it stays as a pointer
  ("ask the operator about the X-shaped failure") or it
  waits for a synthetic reproduction.

### 1. Extract (shape-not-detail, every line)

- The transform: private value → shape. An address becomes
  "a single A record, TTL 60" or "an RFC1918 range"; a
  credential becomes "a Bearer [REDACTED] the relay"; a topology
  becomes "two sites, one authenticating against the other";
  a password becomes ABSENT (not a shape — the sticker red
  line: identifiers extracted, the secret masked local-only,
  never logged, never in a ledger — collected: brief § auth
  red line + explainer §SAM).
- Patterns worth extracting (collected: brief + concept
  review): wiring shapes (how tools composed), auth scheme
  shape (what proved what, where secrets lived), failure
  modes (what broke, what the symptom was, what fixed it),
  reuse judgments (what to copy, what to avoid, and why),
  measurement shapes (timeouts, counts, sizes — numbers
  travel, identities do not).
- Commit-history mining (collected: concept review §10
  inputs): decisions files + backlog + whiteboard history
  carry ownership, identity, capture provenance, and recorded
  evolution — mine the EVOLUTION (what changed and why), not
  the contents. Rough-count precedent: "~80 field-work, ~50
  config, ~20 dashboard, ~20 tools over 150 commits" teaches
  effort shape with zero private content (collected:
  claude-code-feedback commit census).
- Live by the carry-across sentence (collected: concept
  review): carry across their MEANING, not private
  inventories, addresses, credentials, topology, code, or
  deployment-specific assumptions. When unsure, the meaning
  without the noun: "the tunnel token leaked through an
  unredacted env line" teaches; the token itself must never
  appear.

### 2. Label (every claim carries status + evidence)

Claim labels from the brief (collected: brief "What to
produce" + habitat sections):

- [VERIFIED] = you ran/checked it in session, source named.
- [JOURNALED] = repo history or another agent's record says
  it happened (cite the record, not your memory of it).
- [OPINION] = your recommendation (reasons shown, not
  asserted).
- [APPLICANT]/[DEVELOPER] = the human stated it (source
  linked, date noted). [PENDING] = still to confirm.
  [ASK MUSE] = only the named habitat can check it.

House style, because someone will ask "did you test it"
(collected: brief closing): every claim carries its evidence
AND its status; never let PENDING read as DONE; if live
evidence contradicts a doc (including the brief itself), say
so and name the doc/line. The grounds-file pattern is the
same discipline at scale: every application claim traces to
a line with a status tag (collected: grounds and references,
[VERIFIED]/[APPLICANT]/[PENDING] tags).

- Evidence-ledger compatibility (#30): observed/collected/
  inferred/pending labels map onto these 1:1 — use whichever
  vocabulary the consuming doc uses, but never an unlabeled
  claim.
- Contradictions are findings, not embarrassments: when
  habitats disagree (sandbox DNS vs Mac dig, TCG vs HVF
  timing), record WHICH habitat each result came from —
  reach differences are data, not contradictions (collected:
  brief § habitats).

### 3. Gate (synthetic examples, scrub, handoff)

- Examples are SYNTHETIC: "examples are synthetic; no private
  locations or topology are reproduced" and the closing
  attestation "no private network identities, addresses,
  credentials, or topology are included" (collected: concept
  review §10 framing + closing). Write the example from the
  shape, then re-read it asking "could the operator's
  neighbor identify the network from this" — if yes, blur
  further.
- Self-review before handoff: grep the draft for the forbidden
  cargo (§0); read it as the operator (flinch test); confirm
  every private-dependent lesson survived as shape-only or
  was cut to a pointer.
- #31 gates publication: runtime-state sweep, D1 tiers,
  zero-findings gate, clean-home staging, pair review. The
  extraction draft enters #31 like any other publish
  candidate — extraction care does not waive the scrub.
- Handoff shape (collected: brief delivery): one doc, sections
  for patterns / design feedback / story-vs-results flags /
  test results, changes listed at top if revising. Point at
  state (paths, commits, record IDs); do not paste copies of
  private sources — not even "just for context".

## Part 2 — Skill doc

### Trigger

Load when: learning from a private workspace; writing up
lessons from a network you cannot show; reviewing whether a
write-up leaks; "what may travel from private to shared"
questions; scoping someone else's extraction assignment.
(Entry-skill + capability-probe pattern: K22.)

### Prereqs

- Read access to the private source + the operator's consent
  for extraction (not just access — consent to PUBLISH
  patterns from it).
- The consuming doc's claim vocabulary chosen (brief labels
  vs evidence-ledger labels).
- #31 available for the publication gate.

### Access

- Reads of the private source follow its own access rules;
  extraction adds no new read rights.
- The draft lives in the SHARED folder from the first line —
  never draft extraction inside the private repo and "move it
  later" (the move is where leaks hide).
- Operator review before any publish step: the operator who
  owns the private source reads the draft, not just the
  scrub report.
- No private source is pasted, quoted at length, or attached
  to the draft "for reference" — shapes only, always.

### Envs

| Name | Use |
|---|---|
| (none required) | Extraction is reading + writing; no service env |

Private-repo credentials (if any) stay in their existing
store and take no part in the draft. No env carries private
content toward the shared folder.

### Outputs

- Scoped assignment (wanted + forbidden, §0).
- Pattern write-up: wiring/auth/failure/reuse shapes.
- Labeled claims (every claim with status + evidence).
- Synthetic examples + flinch-test pass note.
- #31 scrub record + handoff doc.

### Verification

- Forbidden-cargo grep over the draft: zero private code,
  names, addresses, credentials, topology, serials.
- Every claim labeled; every PENDING visibly pending; every
  contradiction naming doc/line.
- Every example synthetic (attestation line present).
- Operator read confirmed (not assumed from access).
- #31 gate green before any publish step.
- Claim audit: each extraction claim carries source + status
  or an honest pending label.

### Recovery

- Suspected leak in the draft → delete the value, blur to
  shape, re-run the flinch test; if already shared, rotate
  if live and record as an anomaly (evidence-ledger
  precedent).
- Private-dependent lesson that will not blur → cut to a
  pointer ("ask the operator") or commission a synthetic
  reproduction; never publish the detail "just this once".
- Operator flinch at review → the operator is right: blur
  further or cut, no argument from the extractor.
- Label dispute → the weaker label wins (VERIFIED needs a
  run you can point at; otherwise it is JOURNALED).

### Limits

- Extraction is lossy by design: some lessons cannot travel
  — the skill names the loss (pointer), never smuggles the
  detail.
- Synthetic examples teach shapes, not instances: a reader
  who needs the instance needs operator access, not a better
  example.
- The brief → feedback precedent ran ONCE, in one direction
  (Mac → shared folder) — other habitat pairs re-prove the
  pipeline, they do not inherit it.
- Operator consent is per-extraction: access last month is
  not consent this month.
