---
name: capture-drift-hygiene
description: "Keep intent and observation apart and drift visible: pull-first captures, freshness clocks, checker verdicts, drift list discipline, last-good retention. Use when: reading router state into records, reconciling plan vs capture, triaging a stale or partial pull, or deciding what changed."
topics: [drift, intent, evidence]
tested: none
---

# `capture-drift-hygiene` skill (pull → verify → compare → list) [template v1 draft]

Promoted from the record contracts, partial vocabulary, and
drift-as-a-list rules, the pull + checker implementation (pull.ts,
checker.ts, sanitize.ts), the template conventions (conventions.md,
observations/README.md, operations/drift.md), and a live checker
run over two capture devices. No secrets below; device
names + byte counts only.

## Part 1 — The checklist (intent here, observation there)

Run top to bottom. The load-bearing rule fits in one line: intent
is written by people and agents, observations are written only by
the pull, and disagreement goes on the drift list.

1. Pull first, never hand-write state (§0): the pull is the only
   writer of observations; re-pull beats recollection.
2. Verify before use (§1): checker-clean + serial-gated, or the
   capture is not evidence.
3. Read the freshness clocks (§2): three clocks, never one —
   content-changed vs last-observed vs last-attempted.
4. Reconcile on the drift list (§3): plan-vs-capture delta goes
   to drift.md or the router gets fixed; the plan never silently
   rewrites to match.

### 0. Pull (the only writer)

- One writer per record class: captures are pull-written,
  plans are human/agent-written. An agent that hand-edits a pull
  (or writes "observed" state from memory) has corrupted the
  evidence layer — re-pull instead. Template rule: router-owned
  pulls under `observations/` are read-only evidence (conventions.md).
- Observations carry device/source/time/completeness: every
  pull lands as `observations/<device>/pull-<timestamp>/` with
  `manifest.json` (target, serial, time, tool versions, sha256
  per file) and `latest` repointed at it. The manifest IS the
  completeness statement — file list + sizes + statuses.
- Stable IDs survive address changes: devices are bound by
  serial, not address. The serial gate refuses a pull from the
  wrong box (exit 2 + `attempt.json`, `latest` untouched —
  proven in an early pull session). An address book
  pointing at the wrong box is a refused pull, not a merged lie.
- Raw pull dirs are LOCAL-ONLY (git-ignored); what commits is the
  redacted sibling `summary.md` (device, three clocks, file list,
  checker verdict — no serials, no secrets). The summary points
  at the raw pull; it never replaces it (capture boundary,
  conventions.md).

### 1. Verify (checker-clean or it isn't evidence)

Live run 2026-10-29 on a Linux host, `bun checker.ts --all` over `pull/out/`:

```
{"device":"prod-1","ok":true,"dir":"out/prod-1/latest","totalBytes":49294,"files":5,"problems":[]}
{"device":"twin","ok":true,"dir":"out/twin/latest","totalBytes":1772,"files":5,"problems":[]}
```

- Exit 0 clean / 1 problems; one JSON line per device. Checks:
  manifest schema (target, serial, capturedAt, tool versions,
  per-file sha256 + bytes, status in ok/partial/refused),
  per-file existence + byte size + sha256, `latest` symlink,
  total bytes (checker.ts, read this session).
- Status vocabulary (enforced by pull.ts exit codes): `ok`
  (exit 0), `partial` (some reads failed — exit 0, notes name
  them), `refused` (serial mismatch — exit 2, nothing
  published), `running` (in flight). Partial keeps last-good
  files: a failed pull is a finding, and last-good stays until a
  better pull replaces it.
- Negative probe precedent: a tampered fixture fails correctly
  (checker lane, 8 checker tests green). Trust in the checker is
  anchored, not assumed.
- `_sample/` (templates/network/observations/_sample) holds synthetic
  capture data with a valid manifest so the checker proves
  itself on a fresh clone — the ONLY committed pull-shaped dir
  (pre-publish-scrub fixture rule).

### 2. Freshness (three clocks, never one)

From observations/README.md (template, read this session):

- `content_changed_at` — the pull's bytes differ from the last
  good pull. Answers "did the config move".
- `last_observed_at` — the last pull that actually read the box.
  Answers "when did we last see it".
- `last_attempted_at` — the last try, success or failure.
  Answers "are we still looking".

A quiet box with fresh pulls is healthy, not stale: unchanged
content + recent observed = calm. A failed pull moves only
`last_attempted_at` — healthy data never looks unobserved.
Views cite data plus time and never outrun their freshest
cited observation (workflow Reports rule).

Triage shapes:

| Clocks | Reading |
|---|---|
| content old, observed fresh, attempted fresh | Healthy quiet box. No action. |
| content fresh | Config moved — diff it: intended (proposal?) or drift? |
| observed stale, attempted fresh | Pulls failing — a finding, investigate the path. |
| attempted stale | Nobody's looking — the loop lapsed, not the box. |
| attempted fresh, observed fresh, status partial | Degraded reads — notes name what's missing; last-good covers the gaps. |

### 3. Reconcile (drift list or fix the router)

- Disagreement between plan (`router.toml` + inventory) and
  capture goes on `operations/drift.md` OR the router gets fixed.
  Live entries only; resolved entries move to the
  proposal/incident that closed them, citing the clearing pull.
- The plan is NEVER rewritten to match the capture unless that
  is the recorded decision, with an owner. The one allowed
  plan-from-capture direction: a decided import step when
  adopting an existing network (pull first, adopt captures,
  write plan from observed — workflow Setup rule).
- Drift entry shape (operations/drift.md): observed (pull +
  time), plan says, capture says, owner, resolution. Sample
  entry evaporates on first verified pull — the list starts
  empty-by-construction, not empty-by-hope.
- Close checks: re-pull, confirm the entries clear, cite the
  clearing manifest in the closing proposal (workflow
  Configuring step 4). A drift entry closed without a clearing
  pull is pending, not closed.

## Part 2 — Skill doc

### Trigger

Load when: reading router state into records; plan and capture
disagree; a pull is stale, partial, or refused; "what changed?"
or "is this data fresh?" questions; designing a capture pipeline.
(Entry-skill + capability-probe pattern.)

### Prereqs

- Devices bound by serial (identity before evidence — first pull
  establishes the binding, later pulls enforce it).
- pull + checker runnable (anchor tests
  green proves the tooling before the data).
- The plan readable (`router.toml` + inventory): drift needs both
  sides, capture alone is just a pile of files.

### Access

- Pulls are reads: safe on any box, production included, any time.
- Raw pulls local-only always; summaries commit. The override
  (redacted raw into git for multi-agent sharing) is documented,
  on-request-only, stated with its caveat, never volunteered.
- Drift-list writes are record writes (agent-owned files):
  no router approval needed, but entries carry owners.

### Envs

| Name | Use |
|---|---|
| (none) | Pull/checker take CLI flags (`--device`, `--all`, `--out`); no environment. |

### Outputs

- A verified pull (manifest + files + `latest`) or a named
  refusal/partial with notes.
- A checker verdict (JSON line per device, problems listed).
- Freshness reading (three clocks + triage row).
- Drift entries (or confirmed absence) with owners.
- Clearing pulls cited in closing proposals.

### Verification

- Checker exit 0 + empty problems before any capture is used
  as evidence. No exceptions for "just a peek" — peeks become
  citations.
- Serial match on every pull (gate, not eyeball).
- Drift list reviewed against the latest pull before any
  change-apply proposal (change-apply's twin-proof covers the
  change; this covers the baseline it lands on).
- Summaries commit without serials/secrets (pre-publish-scrub
  tiering on the summary content).

### Recovery

- Checker problems: missing file → re-pull; sha256/bytes
  mismatch → treat as tampering-or-corruption, re-pull to a NEW
  dir, keep the suspect dir for forensics, never "fix" it.
- Serial refusal: stop — wrong box or swapped hardware. Resolve
  identity (first-contact) before anything else; the refusal is
  the protection working.
- Partial pull: read the notes, use last-good for the missing
  pieces with their older clocks cited, schedule the re-pull.
  Partial data cited without its notes is mis-cited.
- Drift flood (many entries at once): suspect a bad baseline
  (import step skipped?) or a real mass change (upgrade?) —
  triage the cause before clearing entries one by one.

### Limits

- The checker verifies capture INTEGRITY (schema, hashes,
  bytes), not capture TRUTH: a clean pull from a
  misconfigured box is faithfully wrong. Truth comes from
  reconcile (§3), not verify (§1).
- Freshness clocks need a running loop: one-shot pulls give
  one timestamp, not three clocks. The look-after loop
  is what makes clocks meaningful.
- Export isn't backup: `/export` omits menus on some versions
  (UM + smb missing on 7.26beta3, journaled) — the pull's file
  list is the completeness statement, and gaps in it are
  findings, not fine print.
- Template drift flow is sample-shaped until first real use:
  DRIFT-000 evaporates on the first verified pull; the first
  real entry writes the precedent this skill then follows.
