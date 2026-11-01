---
name: evidence-ledger
description: "Dated command+output ledgers with claim labels and anomaly notes: the evidence practice behind every verdict. Use when: recording a run, writing up an incident or proof, reviewing whether a claim is observed or merely collected, or closing a task with evidence attached."
topics: [evidence, records, claims-discipline]
tested: none
---

# `evidence-ledger` skill (log → label → note → attach) [template v1 draft]

Promoted from standing practice, not a new invention: twin
transcripts, incident write-ups, and tracker updates
already follow it (the ledger is the evidence; observed
vs inferred marked separately).
No secrets below; the ledger rules say what never enters one.

## Part 1 — The checklist (claim = command + output)

Run top to bottom. A verdict without a ledger is a rumor with
confidence.

1. Open the ledger entry first (§0): date + environment + machine + the
   question, before running anything.
2. Log every claim as command + output + environment (§1): paste the
   exact command and the load-bearing output, trimmed but never
   paraphrased into a better result.
3. Label each claim and note anomalies (§2–§3): observed / collected
   / inferred / pending — plus anything surprising, even (especially)
   good news that arrived too easily.
4. Attach and close (§4): tracker evidence points at the entry, a handoff
   note carries the summary, unrun halves stay listed as pending.

### 0. Open (the header is the provenance)

Every ledger entry — a `notes/*.md` run note, an `operations/`
incident record, a handoff note — opens with the same four facts:

- **Date** (YYYY-MM-DD, UTC): when the commands ran, not when the
  note was edited. Stale runs are data, but only when dated.
- **Environment + machine**: which sandbox/environment, which host, which
  router or twin (name + firmware + packages). Results move with
  their environment: the same tunnel that is dead from the cloud sandbox
  is live from a LAN workstation (vpn-setup §0), and the ledger is where that
  difference lives instead of becoming a contradiction.
- **The question**: one line naming what this run decides. No
  question = no run (twin-ops prereqs).
- **Prior state**: what existed before the first command (host PIDs,
  config baseline, wedge already present). Recovery and blame both
  start here.

Precedent: a bisection note opens with date + host + untouched
twins + no-production-contact + prior-state pointer; a staged-run note
opens with target + firmware + date + what was previously un-run.

### 1. Log (commands verbatim, outputs trimmed honestly)

- Paste the EXACT command: flags, quotes, target selectors. The next
  agent re-runs from the ledger; a paraphrased command is a new
  experiment, not a reproduction. Precedent: a staged-run note's six-step
  transcript, each `centrs execute` line followed by its `->`
  output.
- Trim outputs to the load-bearing fields, and say so (`outputs
  trimmed to the load-bearing fields`). Keep: ok/fail, ids (`*3`),
  counts, verdict fields (`last-handshake`, `db-size`), error codes
  (`validation/unknown-path`). Drop: envelope boilerplate, repeated
  auth blocks, wall-of-text dumps.
- Cycles get tables, not prose: per-cycle configure → pre-state →
  trigger → confirm → post-state rows (a UM campaign ran 6 cycles
  unchanged). Two-signal trigger confirms
  (uptime + write-sect reset) are what make a cycle re-runnable.
- Never paste secrets into a ledger: no passwords, tokens, private
  keys, serials, or identifying addresses. Shapes instead of values
  (`<44ch base64, auto-generated>`, `objectCount 1`). centrs redacts
  what it holds, not what RouterOS returns (centrs#359) — strip
  `private-key` / `show-sensitive` output BEFORE pasting.

### 2. Label (four levels, no hedging words)

Every claim in the entry carries one label. The label is the whole
claim discipline; the words "probably", "should", and "just"
are banned from verdicts.

- **Observed**: ran here, output in the ledger. Strongest form:
  `observed 2026-10-29 vm-host/vpn-twin`. A setup guide's `[VERIFIED
  date]` sections are this label at file scale.
- **Collected**: read from a trustworthy source, not re-run. Cite
  the source exactly (file + line, handoff-note path, issue number). A
  skills backlog marks its entire inventory this way until promotion
  runs execute it.
- **Inferred**: reasoned from observed/collected facts. Show the
  chain in one breath (`A + B → C`) so a wrong link is findable.
  Inferred links are marked separately from observed ones, never
  blended (a git-workflow troubleshooting rule).
- **Pending**: named but un-run. Every entry ends with its pending
  list. Pending is a first-class outcome: it tells the next session
  where to start, and `make check`-style gates can count it.

Downgrades are normal and honorable: an observed claim whose environment
changed is re-labeled collected-with-date until re-run. Upgrades only
happen by running.

### 3. Anomalies (the surprise journal)

Anomalies get their own notes inside the entry, inline where they
happened, because the surprise is usually the finding:

- Record what you expected vs what happened, in one line each. One
  staged-run note's finding 1 is the shape: documented `numbers=` syntax
  failed, positional worked — with the exact error quoted.
- Good news that arrives too easily is an anomaly too: the T3 MCP
  proof recorded that the token was one-shot and died with the test
  (proof, not a durable connection). State what was NOT
  proven alongside what was.
- Field lessons that change future runs get promoted out of the
  entry: the redaction incident (live tunnel token in a first pull)
  became a redactor rule + anchor test the same session
  (the setup guide's redaction section); the `validation/syntax`-means-missing-
  menu trap became a diagnostic procedure (centrs#361).
- Wedges and specimens: when a run leaves a box in a notable state
  (a twin still wedged as a living specimen), the anomaly note names
  the custodian rule — reproduce around it, don't "fix" it silently.

### 4. Attach and close (ledger → tracker → handoff)

- The tracker points at the ledger, never the reverse: the
  tracker's `evidence` field names the note file ("the board tracks
  work while the ledger is the evidence"). Prose in the tracker is a
  pointer, not a copy.
- A handoff note carries the summary for other sessions: verdict + entry
  pointer + pending list. Never edit another session's note (append
  races); write a follow-up that cites it.
- Close checks: header complete, every command has its output or a
  pending label, no secrets (grep for token/key/serial patterns
  before calling it done), twins restored (twin-ops session-end list).
- The entry is done when a stranger can re-run it from the ledger
  alone. If they would need to ask you something, that something is
  missing from the entry.

## Part 2 — Skill doc

### Trigger

Load when: recording any run with a verdict; writing an incident,
proof, or bisection note; reviewing a claim's label; closing a task
with evidence; "where is that proven?" questions. (Entry-skill +
capability-probe pattern.)

### Prereqs

- The question written down (Part 1 step 1 refuses to start without
  it — a ledger without a question is a diary).
- Write access to the entry location (`notes/` for run notes,
  `operations/` for incidents, `inbox/` for cross-session handoff notes).
- The redaction rule internalized: shapes, never values, for
  anything secret or identifying.

### Access

- Run notes are local-first: captures with real network data stay in
  local-only paths (pull `out/`), git-ignored on promotion, never
  committed.
- Handoff notes are shared across sessions and environments: verdicts and
  pointers only, no secrets, no pasted captures.
- Promoted skills cite ledger entries by path; the pre-publish scrub
  decides what survives publication — internal pointers are
  expected pre-scrub, not a violation.

### Envs

| Name | Use |
|---|---|
| (none) | The ledger is a practice, not a program; it needs no environment. |

### Outputs

- A dated ledger entry: header + command/output transcript + labels
  + anomaly notes + pending list.
- A tracker `evidence` pointer naming the entry.
- A handoff summary note (when another session should know).
- Promoted field lessons (redactor rules, diagnostic procedures)
  filed where they execute, not just where they happened.

### Verification

- Claim audit: every sentence with a verb like "works", "fails",
  "proves", or "is" traces to a logged command + output or carries
  collected/inferred/pending honestly.
- Secret scan: no passwords, tokens, private keys, serials, or
  identifying addresses in the entry (automated grep where the repo
  has one; eyeball where it doesn't).
- Re-run test: a second agent follows the entry cold and reaches
  the same verdict (or files the divergence as an anomaly).
- Pending list non-empty-or-explicit: "no pending items" is itself a
  claim, stated, not assumed.

### Recovery

- Ledger fell behind the run (commands ran, nothing logged): stop,
  reconstruct from shell history NOW while it is warm, label the
  reconstruction inferred-with-source, and say what is missing.
- Secret pasted into an entry: delete the value from the file (and
  any capture dir it also touched), rotate the secret if it was
  live, record the incident as an anomaly — the redaction-incident
  precedent, not a cover-up.
- Two ledgers disagree: compare environments + dates first (most
  disagreements are environment differences, not errors); re-run on one
  shared target to settle it.
- Entry too long to follow: split transcript (full commands) from
  write-up (verdict + findings), linked both ways — the staged-run shape.

### Limits

- The ledger proves what ran, not what is true everywhere: every
  observed claim is environment-dated and rots when firmware, egress
  policy, or tooling moves. Re-run beats re-cite.
- Trimmed outputs can hide context: when a verdict is challenged,
  the full output is re-produced from a re-run, never from memory.
- Labels are self-assessed: `observed` means the author ran it, not
  that a second party confirmed it. Adversarial review before apply
  (adversarial-review) is the separate control for high-stakes claims.
- This skill standardizes the practice; it does not enforce it.
  Enforcement is review + the pre-publish scrub + the re-run test.
