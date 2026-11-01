---
name: sidecar-projects
description: "Run one-off custom builds as directory siblings of the managed network: own build, manifest with a records link, declared integration surface, integrate-or-retire lifecycle. Use when: the shelf product is overkill or mismatched, an agent-built gadget earns a home, or a spike needs records without joining the network."
topics: [sidecar, custom-builds, records]
tested: self-test
---

# `sidecar-projects` skill (name → stand up → link → run → integrate-or-retire)

Sometimes the right answer is not a bigger
product but a smaller build: the parable is
a custom ESP32 solar monitor for
a test deployment INSTEAD of an overkill/mismatched Victron
product. It lives in its own directory, is known to the
managed network's records, and keeps a LoRa-gateway
future optional. That flexibility — a directory over
one-size-fits-all SaaS — is the point of this skill.

Collected from pilot feedback: the parable is secondhand; no
source project tree was inspected. The reference fixture is
synthetic, shaped like the parable. The manifest schema
(v1) is PROPOSED — the first real sidecar ratifies or
amends it. Repo grounding: structured records track state
(not prose), the pre-issue layer (unshaped work with no
formality tax, promotion needs an owner + done), and
network-workspace-bootstrap (the workspace the sidecar
sits BESIDE — boundary, not parent). No twin, no box
writes: directories + records only.

## Part 1 — The checklist (a build with an address, or it is clutter)

Run top to bottom. A sidecar without a manifest is a
stray directory; a manifest without a records link is
a wish. The reference checker enforces both halves.

1. Name the build: owner problem + rejected shelf
   alternative WITH reasons (step 0).
2. Stand up the sibling dir: own build, own deps,
   name-bound manifest (step 1).
3. Link it in records: manifest validates, records
   page exists (step 2).
4. Run it: build/test/operate with the integration
   surface declared up front (step 3).
5. Integrate or retire: graduate to a managed
   surface, or retire with a note (step 4).

### 0. Name (problem first, rejection with reasons)

- Problem in one owner-readable line: what breaks or
  stays unknown without this build. If the problem
  fits an existing skill's trigger, this is not a
  sidecar — file it there instead.
- Rejected alternative WITH reasons (validator rule
  S5: min 20 chars of WHY, not just a product name).
  Parable shape: "Full Victron stack: 5× the cost
  for telemetry the owner will not read, and its
  shunt does not fit the existing busbar." Cost,
  fit, and complexity are all valid reasons;
  "we build everything ourselves" is not.
- Status starts at `spike`: unshaped work, no
  formality tax. Promotion to `active` needs
  an owner + a definition of done — same bar as
  pre-issue → issue.
- Observed (self-test): the parable-shaped fixture
  validates; a manifest with a bare product name
  ("Victron stuff") fails S5 naming the rule.

### 1. Stand up (a sibling, not a fork)

- Directory beside the managed network (or beside
  the workspace per network-workspace-bootstrap), never inside it: the
  sidecar's deps, venvs, and build mess must not
  leak into network records. Name == dir (rule S2).
- Own build from day one: README (what + how to
  run), pinned deps, and whatever test proves it
  works. A sidecar with no runnable proof is a
  sketch — keep it at `spike` and say so.
- No shadow management: the sidecar NEVER writes
  to routers except through the network's own
  skills (`change-apply` + approvals). A gadget
  that "helpfully" reconfigures the network is a
  compromised device with good intentions.
- Precedent shape (parabolic, not observed): ESP32
  firmware + a readings path, LoRa gateway left
  as an explicit optional future — futures are
  declared in the manifest detail, not promised
  in chat.

### 2. Link (known to records, mechanically)

- Manifest `sidecar.toml` in the dir (schema v1:
  name, problem, rejected_alternative, records_link,
  integration_surface, integration_detail, status,
  + retired_note when retired). Run
  `references/validate-sidecar.py <dir>`: S1 fields
  present, S2 name==dir, S3 status enum, S4 surface
  enum (+ detail when non-none, integrated ⇒
  non-none), S5 rejection has reasons, S6 retired
  needs its note. Observed: 1/1 good accepts, 4/4
  broken reject naming S1/S2/S3/S5.
- Records page at the linked path: what the network
  knows (problem, status, surface, where the dir
  lives). The manifest points at records; records
  points back at the dir. One link without the
  other fails verification.
- The checker runs on every manifest edit — same
  discipline as the skill gate: unvalidated
  manifests are not "known", they are rumors.

### 3. Run (declared surface, honest status)

- Integration surface declared up front: `none`
  (standalone gadget), `files` (drops readings/
  artifacts where records pick them up), `api`
  (serves/consumes an endpoint), `network` (joins
  traffic — rarest, needs its own threat look).
  Surface creep (files → network) re-enters at
  step 0 with the new surface named.
- Operate inside the surface: the parable's daily
  CSV into records is a `files` surface done
  right — no daemon, no inbound port, no creds.
  Status moves spike → active when the owner can
  rely on it (done-criteria met, not vibes).
- Evidence per `evidence-ledger` for anything the
  network consumes: readings carry source + time;
  a sensor whose data feeds a decision gets the
  same claim labels as a pull.

### 4. Integrate or retire (no permanent limbo)

- Integrate: the sidecar graduates — its surface
  becomes managed (a skill, a workspace chapter,
  a monitored feed). Status `integrated`, detail
  names the new home. The dir stays (history) but
  records point at the managed successor.
- Retire: the problem went away or the shelf
  product caught up. Status `retired` + note
  naming what replaced it (rule S6). Retired dirs
  are archived, not deleted — the rejection
  reasons stay readable for the next "should we
  buy X" question.
- Review cadence: every active sidecar re-asks
  step 0 yearly (problem still real? alternative
  still rejected?). A sidecar nobody re-asks is
  how clutter compounds — the review date lives
  on the records page.

## Part 2 — Skill doc

### Trigger

Load when: the shelf product is overkill/mismatched
for an owner problem; an agent-built gadget needs a
durable home; a spike outgrows chat; or asking "where
does this custom build live".

### Prereqs

- The parable + schema v1 read (this doc).
- A named owner problem + a rejected alternative
  with reasons (step 0 inputs).
- python3 (3.11+ tomllib) for the reference
  checker; stdlib only.
- Write access to the sibling location + the
  network's records (both, or link later — say so).

### Access

- Directories + records only: safe anywhere. No
  twin, no box contact, no network writes — a
  sidecar that needs those goes through the
  network's skills like any other change.
- Sidecar contents (firmware, keys, readings) stay
  in the sidecar dir under privacy tiers; the manifest
  + records page carry no secrets.

### Envs

No environment this skill consumes. Per-sidecar
toolchains (ESP32 SDK, venvs, radios) live inside
the sidecar dir and are that build's problem.

### Outputs

- Sidecar dir (build + README + proof it runs).
- Validated `sidecar.toml` manifest.
- Records page, cross-linked both ways.
- Integrate/retire verdict with its note, when due.

### Verification

- Checker accepts the manifest (exit 0); every
  rejection names its rule (self-test pins 5/5).
- Records page exists at the linked path and
  points back at the dir.
- Status matches reality (spike = unshaped,
  active = relied-upon, integrated/retired noted).
- No router writes outside the network's skills;
  no secrets in manifest or records page.

### Recovery

- Manifest rejected → fix the named rule; schema
  disputes amend the SCHEMA (v2, with reason),
  never silently diverge one manifest.
- Records link broken → the sidecar is unknown
  until re-linked; pause reliance, fix the link.
- Surface creep discovered → stop the new surface,
  re-enter at step 0, name it before resuming.
- Owner problem evaporates → retire with a note,
  do not keep the build warm "just in case".

### Limits

- Schema v1 is proposed: validator + fixture are
  proven, but no real sidecar has ratified the
  fields. First real sidecar amends or confirms.
- The parable is collected text, not observed
  practice — no build transcripts, no readings,
  no LoRa gateway exist in-repo. Do not cite the
  parable as proof a sidecar works.
- This skill hosts builds beside the network; it
  never manages the network (skills own that),
  never approves purchases (owner owns that), and
  never retains a sidecar past its review date
  without re-asking step 0.
