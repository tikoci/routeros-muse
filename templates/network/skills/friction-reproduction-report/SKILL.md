---
name: friction-reproduction-report
description: "Turn friction into upstream-ready reports: reproduce on a twin first, capture command plus output, check open issues before filing, comment rather than duplicate. Use when: something broke or surprised you, writing a bug report, filing or triaging an upstream issue, or asking whether a finding is real enough to report."
topics: [testing, debugging, github]
tested: none
---

# `friction-reproduction-report` skill (feel → reproduce → check → file) [template v1 draft]

Promoted from the standing repo rules (reproduce-first, claim =
command + output, issues-first upstream), an upstream-issues
triage file (numbered friction items with repro shapes), the
twin-proof transcripts, and the landed-issue trail
(centrs #543/#544/#545, #541). This is the skill form of
prefs-level repo rules — the rules stay authoritative; this
skill teaches their exercise. No secrets below; repros carry
shapes, never live credentials.

## Part 1 — The checklist (no claim without a run)

Run top to bottom. A friction is reportable when it reproduces
on demand, its evidence names command + output + environment, and
its upstream state is checked (filed, linked, or queued —
never duplicated).

1. Feel it, write it down (§0): friction log entry at first
   touch, honest unknowns.
2. Reproduce it (§1): twin first, exact commands, trimmed
   outputs, verdict line.
3. Check upstream state (§2): open issues first, link don't
   duplicate, triage honestly.
4. File it right (§3): issue-first, repro-shaped, scrubbed,
   queued or PR'd with linkage.

### 0. Feel (log the friction while it is warm)

Standing rule (observed AGENTS.md): Claim = command + output.
Unrun = pending. Reproduce on a twin first. The friction log
is where that starts: at the FIRST touch of surprise — a wrong
error, a confusing shape, a timeout with no cause — write the
entry before diagnosing. Memory of friction decays faster than
any other evidence.

- Entry shape (collected: triage items + connector-onboarding
  friction logs): numbered, titled, with the exact command (or
  action), the observed output (or symptom), what was expected,
  and what's UNKNOWN. Unknown-attribution is a first-class
  field: "device-side vs centrs-side (MTWEI/MD5 negotiation?
  7.26beta change?)" is an honest entry, not an incomplete one
  (collected: the triage file).
- Environment + versions on every entry: machine, OS/hypervisor,
  tool versions, target firmware. "Fails on the test host" without
  versions is a rumor; "centrs 0.1.9-next, CHR 7.26beta3,
  KVM host" is a report (collected: the proof header shape).
- Owner-flagged classes get flagged at entry time, not triage
  time: agent-hostile CLI output, secret-bearing output with no
  warning, silent fallbacks (collected: the triage file —
  the `/export` TUNNEL_TOKEN return and the ANSI/OSC8
  `--once` output were flagged as CLASSES, with instances
  attached).
- NEEDS TRIAGE is a valid state (collected: the triage
  header) — it means "logged, not yet reproduced", and it must
  never be mistaken for "ready to file".

### 1. Reproduce (twin first, commands verbatim)

Standing rule (observed NEEDS.md + AGENTS.md): reproduce
locally; twins are yours (never delete a twin others rely on —
make your own for dirty work); production writes need explicit developer
approval per item. Reproduction happens on a twin or
disposable CHR FIRST; production only confirms, never
discovers.

- Proof transcript shape: date /
  host / machine / driver header, redaction note up front
  (key material to shape, keys died with the twin, no
  production contact), then commands with outputs TRIMMED TO
  LOAD-BEARING FIELDS, then a VERDICT line ("Handshake PROVEN:
  mirrored rx/tx both directions, last-handshake 20s").
  Trim honestly — trimming is editing for signal, not hiding
  counter-evidence; anomalies get their own notes.
- Reproduce the FAILURE, not just the success path: the BTH
  relay refusal was proven by a MATRIX (curl empty-reply,
  Python RemoteDisconnected, Chromium ERR_CONNECTION_CLOSED,
  IP-addressed probe empty, text-fetch 403) with the
  residential-network control passing — one failing command is
  an anecdote, a matrix with a control is a finding
  (collected: the BTH live test).
- Review-grade tables for behavior claims: the CHR 7.25
  group×transport matrix (6 rows, pass/500(9)/trap each)
  settled the `api`-policy question across four firmwares
  because every cell named group + transport + outcome
  (collected: an earlier design review). A claim of the form
  "X needs Y" earns a table, not a sentence.
- Negative results are results: "UDP blocked at syscall
  (sendto → EPERM)", "TCP fallback never activated in
  testing", "quick tunnel creation dies on the intercepted
  path AND 403s through the proxy" — each closed a design
  door permanently (collected: the brief + design
  notes). Record what you ruled OUT with the same care as
  what you ruled in.
- Teardown is part of the proof: machines removed, test
  users/groups/scripts off the box, captures scrubbed or
  local-only, twin pristine-verified (collected: the proof
  teardown shape + staged-run pristine cleanup). A repro that leaves
  residue is half a repro.

### 2. Check (open issues first, link don't duplicate)

Standing rule (observed NEEDS.md): check open issues/PRs
first (comment, don't duplicate). Triage rule (observed
the triage header): check open issues first, strip
creds/addresses, comment rather than duplicate. A later pass
(possibly another agent working those repos) files them —
triage and filing are separate steps with separate owners.

- The check, in order: search the upstream tracker for the
  symptom AND the cause (different reporters file different
  halves); read the open matches fully; if one matches, LINK
  it ("Live instance: ...; do not duplicate") and add your
  repro as a comment-shaped note — never a second issue
  (collected: triage items citing rosetta#168/#167
  as already-open, with live instances attached).
- Triage states that mean something: NEEDS TRIAGE (logged,
  unreproduced) → reproduced (transcript exists) → queued
  for filing (scrubbed, shaped) → filed (issue/PR linked) →
  landed (fix merged + behavior re-verified live). The
  needs trail shows the full arc: triage items →
  branches → PRs (centrs #543/
  #544/#545) → merged (#541) → live re-verification
  → follow-through task.
- Attribution honesty survives triage: "Unknown: device-side
  vs centrs-side" travels WITH the item until a test settles
  it (collected: the triage file). Triage narrows unknowns;
  it never deletes them by optimism.
- Cross-repo routing: file where the fix lives (centrs vs
  quickchr vs rosetta sections in the triage file), note the
  seam when the bug sits between repos (CDB fan-out? MCP
  wrapper vs server? transport vs router?), and say which
  repo's maintainer decides.

### 3. File (issue-first, repro-shaped, linked for life)

Standing rule (observed AGENTS.md): upstream fixes go upstream
as PRs (issues first, comment don't duplicate). The issue is
the unit of discussion; the PR is the unit of fix; the issue
exists FIRST even when you already hold the patch.

- Issue body shape: title naming symptom + surface; environment +
  versions; minimal repro commands (verbatim, scrubbed);
  observed vs expected; the matrix or table if behavior varies;
  unknowns stated; related issues linked (not duplicated).
  Strip creds/addresses before drafting — scrubbing is a
  filing step, not a pre-publish afterthought (collected:
  the triage rule).
- The scrub is literal: passwords to `<throwaway>`,
  keys/tokens to shape ("44-char base64"), addresses to roles
  ("router LAN", "twin NIC"), serials deleted. The leaked-
  token postmortem (live TUNNEL_TOKEN in `/container/add
  env=...`, caught by spot-check, fixed + re-pulled + anchor-
  tested same session) is why scrubbing precedes filing, not
  follows it (collected: pre-publish-scrub §0).
- Linkage for life: the local record (needs evidence,
  task evidence, proof note) cites the issue/PR number; the
  issue cites the repro; the fix PR cites the issue; the
  re-verification cites the merge. "centrs PR #541 MERGED 2026-10-28;
  fixed behavior verified live" is the
  closed loop (observed the needs trail). An issue filed but never
  linked locally is a rumor with a number.
- Filing is not landing: filed → open PR → merged → behavior
  re-verified live → follow-through. centrs #547 OPEN (mac-telnet
  broadcast egress) vs #541 MERGED+re-verified shows two
  different states of done — report the state you have, not
  the state you want (observed the needs trail).

## Part 2 — Skill doc

### Trigger

Load when: something broke or surprised you; writing a bug
report; filing or triaging an upstream issue; "is this real
enough to report" questions; reviewing someone else's repro;
closing the loop on a merged fix. (Entry-skill +
capability-probe pattern.)

### Prereqs

- A twin or disposable target for reproduction (never delete
  a twin others rely on; dirty work gets a fresh machine).
- Tool versions + target firmware known and recordable.
- Upstream tracker readable (search before filing).
- Evidence-ledger habit: dated entries, verbatim
  commands, labeled claims.

### Access

- Reads-first: reproduce with reads where the symptom allows;
  writes need the standing write posture (twin free,
  production per-item approval).
- Friction entries are local-first: log in the workspace,
  file upstream only after reproduce + check + scrub.
- Never paste captures, secrets, serials, or private
  addresses into an upstream issue — shapes only, always.
- Never edit another agent's triage entry — append a
  follow-up citing it (coord rule carries over).

### Envs

| Name | Use |
|---|---|
| `CENTRS_*` | Transport auth for repro commands (never the repro subject's secrets) |
| Tool versions | Recorded in the entry, not env (`centrs --version`, firmware, host) |

Throwaway credentials for repros live in shell variables,
rotated per probe, redacted to `<throwaway>` in every record.
No live secret takes part in a reproduction.

### Outputs

- Friction log entry (numbered, environment + versions, unknowns
  stated).
- Proof transcript (commands verbatim, outputs trimmed,
  verdict line, teardown noted).
- Triage state (NEEDS TRIAGE → reproduced → queued → filed
  → landed+re-verified).
- Filed issue / linked comment / PR with lifelong linkage.

### Verification

- Every claim in the report traces to a command + output in
  the transcript, or carries pending/unknown honestly.
- Upstream check evidenced: searched terms + matches read
  named, or "no match found" stated with the search.
- Scrub check: no creds, tokens, keys, serials, or private
  addresses in the filed text (grep before filing).
- Linkage check: local record ↔ issue ↔ PR ↔ re-verification
  all cite each other.
- Claim audit: each report claim carries run evidence or an
  honest collected/pending label.

### Recovery

- Filed a duplicate → close yours with a link to the
  original + move your repro there as a comment; record the
  lesson (search terms that missed).
- Repro stops reproducing → say so immediately (version?
  firmware? environment?); a dead repro is data about scope,
  not a failed task.
- Secret filed upstream → delete the value, rotate if live,
  record as an anomaly (evidence-ledger precedent); tell the
  maintainer plainly.
- Fix merged but behavior unchanged → re-verify live and
  report (the loop closes on BEHAVIOR, not on merge).

### Limits

- This skill teaches the exercise of standing rules — the
  rules (NEEDS.md, AGENTS.md, triage header) stay
  authoritative; conflicts resolve toward them.
- Triage is not filing and filing is not landing: each state
  transition needs its own evidence, claimed separately.
- Another agent may own the filing pass (triage/file split)
  — queued items name their next owner, never "someone".
- Upstream maintainers decide: a well-formed issue that gets
  declined is a complete report, not a failure.
