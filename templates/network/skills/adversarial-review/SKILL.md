---
name: adversarial-review
description: "Second-agent review before anything applies: a reviewer with one job (find what's wrong), findings next to the change, deltas recorded. Use when: a change, proof, or publish is ready for another pair of eyes; staffing the review gate inside an approval; asking 'who checked this?'."
topics: [review, approval, multi-agent]
tested: none
---

# `adversarial-review` skill (draft → review → delta → attach) [template v1 draft]

Promoted from the executed evidence-critic precedent (T2/T20/T21/
T22 research notes, all critic-verified with recorded deltas), the
second-agent doctrine (corpus AGENTS.md:101), and the approval-card
shape (homework §2/P5). Backlog #33. No secrets below; findings
travel by shape, never by pasted secret.

## Part 1 — The checklist (fresh eyes, one job)

Run top to bottom. The reviewer is not a second author and not a
rubber stamp: one job — find what's wrong.

1. Draft to reviewable (§0): the change self-contained enough
   that a stranger can check it cold.
2. Staff the review (§1): a second agent, briefed on the job,
   with no stake in the draft.
3. Record findings + deltas (§2): what the reviewer found, what
   changed because of it, next to the change.
4. Attach to the approval (§3): findings ride the approval card;
   the approver sees the review, not just the draft.

### 0. Draft (reviewable, or don't staff it)

- A reviewable draft: the change (commands, config, proof, or
  publish set), the ledger behind it (evidence-ledger: commands
  + outputs + habitat), the claim it makes, and what would
  prove it wrong. A draft the reviewer can't check cold isn't
  ready — it goes back, and the bounce is recorded, not
  resented.
- Scope the review in one line: "check the group policies
  against the twin read-back", "verify every gh link resolves",
  "find the HIGH-tier value I missed". Unscoped reviews find
  vibes; scoped reviews find bugs.
- The author states known weak spots UP FRONT (pending list,
  collected-not-rerun halves, version caveats). Hiding a weak
  spot to "test" the reviewer poisons the well — the reviewer's
  job is finding what's wrong, not finding what's hidden.

### 1. Staff (second agent, no stake)

Doctrine (corpus AGENTS.md:101): "Before a change reaches the
applicant (in the build) or the owner (in the product), a second
agent reviews it with one job: find what's wrong."

- During the build: parallel agents reviewing each other (the
  research batches ran this way — T20/T21/T22/T2 drafts each
  carry "evidence-critic verified" provenance with the critic's
  method named: DB counts re-run, gap table re-checked, file
  refs + tracker state re-checked via gh).
- In the product: the workspace instructions tell the owner's
  agent to ask a subagent or second agent to check its work —
  same rule, smaller ceremony.
- No stake: the reviewer didn't write the draft and isn't
  measured on its landing. Reviewing your own draft after lunch
  is a re-read, not a review — label it honestly.
- Async by default: post the draft for review, keep working
  elsewhere, never block a session waiting on a reviewer (the
  standing review rule). The review lands when it lands; the
  change waits for the review, not the author for the reviewer.

### 2. Findings + deltas (next to the change, both)

"Write the reviewer's findings, and what changed because of them,
next to the change." Executed shape from the research notes:

- T20: draft said 43 device-matrix columns; critic verified 39
  via `.schema` + `PRAGMA table_info` — the delta (43→39 +
  method) is IN the note, not in a chat log.
- T2: critic added the nuance that row 12's gap holds only for
  `--once`/non-interactive use (interactive number-select opens
  full pages) — a scope correction with the code path cited.
- T21/T22: critic re-verified GitHub Free facts live and file
  refs + tracker state via gh — method named per note.

Finding hygiene:

- Each finding: location, what's wrong, the evidence (command +
  output, file + line, live check). "Looks off" is not a
  finding — it's a draft back to the reviewer for specifics.
- Each delta: what changed in the draft because of the finding,
  or "disputed: author's rebuttal + who decides". Disputes
  resolve by re-running, never by seniority.
- Severity is the author's triage AFTER seeing findings, not the
  reviewer's flattery filter: the reviewer reports everything
  found; the author dispositions each (fixed / disputed /
  accepted-risk with owner).

### 3. Attach (findings ride the approval)

- The approval carries plan + reviewer findings: the demo
  catalog's P5 probe states the pass signal as "card shows plan
  + reviewer findings; tap → action runs" (homework P5). The
  approver approves the REVIEWED change, with the review
  visible — never the draft alone.
- Approval UI halves: Muse's per-action approval cards on the
  phone are the proposed surface [OPINION, ASK MUSE — the card
  UI itself is uncommitted platform surface]; the fallback is a
  WebFig "run it yourself" link as the approval (same P5 row).
  Either way the FINDINGS ATTACH — the card-vs-link question is
  UI, the findings-on-approval rule is doctrine.
- Staged-script approvals (change-apply/K19: human runs the
  script under their own login): the script IS the immutable
  plan (one copy, read back, run-count visible) and the review
  findings attach to the proposal record it came from. RouterOS
  checks the human's rights at run time; the review checked the
  script's sense before that.
- Review stays async (pre-publish-scrub staging rule): post for
  review, don't wait on it, never publish/apply while review is
  pending. "Pending review" blocks the CHANGE, not the author.

## Part 2 — Skill doc

### Trigger

Load when: a change, proof, publish set, or close-out is ready
for another pair of eyes; staffing a review (as author or
reviewer); "who checked this?" questions; designing an approval
flow. (Entry-skill + capability-probe pattern: K22.)

### Prereqs

- A reviewable draft (§0): change + ledger + claim + falsifier.
  No draft, no review — reviewing intentions is chat, not work.
- A second agent available (build) or a subagent budget
  (product). Solo with no second mind: say so, downgrade to
  re-read, and mark the change single-eyed.
- The scope line written before staffing. The reviewer may
  widen it (and says so); they may not narrow it silently.

### Access

- Reviewers read everything the draft touches (captures
  included — that's the job) and write ONLY findings + the
  review record. The draft stays the author's to change.
- Findings with secrets travel by shape ("HIGH-tier value in
  file X line Y"), never by pasted value — findings are
  shared wider than drafts.
- Production approval rights stay with the approver (human):
  the reviewer advises, the approver decides, RouterOS enforces
  at run time. No agent approves its own change.

### Envs

| Name | Use |
|---|---|
| (none) | Review is reading + judgment; it needs no environment. |

### Outputs

- Review record: reviewer, scope, method per claim checked.
- Findings list (each: location + wrongness + evidence).
- Deltas (each: finding → draft change, or dispute + decider).
- Approval attachment: plan + findings in one view for the
  approver's decision.

### Verification

- Every draft claim traces to a reviewer check or an explicit
  out-of-scope (scope line + "checked / not checked" per
  claim — the T20/T21/T22 provenance-line shape).
- Deltas re-verified, not assumed: a fixed finding gets its
  fix checked, ideally by the same reviewer.
- Approval shows the review: an approval record without
  findings attached (or "no findings" stated) is incomplete.
- Single-eyed changes labeled as such, with the reason (no
  second agent, time-box, triviality) — never silently solo.

### Recovery

- Reviewer finds the draft unreviewable: bounce with specifics
  (what's missing for a cold check), author re-drafts. The
  bounce is process working, not friction.
- Author disputes a finding: re-run to settle (the disputed
  command, the cited file, the live check). Persistent dispute
  escalates to the approver WITH both positions attached.
- Review overturned by events (firmware moved, habitat
  changed): the review is habitat-dated like any claim —
  re-scope and re-review the affected half, keep the rest.
- Rubber-stamp suspicion ("LGTM" in 30 seconds on a 40-claim
  draft): the provenance line convicts or clears — method per
  claim, or it didn't happen.

### Limits

- WITH-SOURCE DEDUPE vs workflow (backlog Q1, answered here by
  reading the skill): workflow covers lifecycle stages +
  GitHub adapter + bootstrap; its Configuring step applies via
  staged-script but names NO review procedure. This skill IS
  that procedure — it feeds workflow's Configuring gate, it
  doesn't duplicate workflow. Boundary: workflow says what
  stages exist; this says how the review gate works.
- Review proves diligence, not correctness: two agents can
  share a wrong assumption (same docs, same version skew).
  Independent re-derivation beats re-checking for high-stakes
  claims — say which the review was.
- Approval-card UI is opinion/ask (platform surface may differ
  by harness — presentation-layer, backlog #55): the
  findings-ride-approval rule holds regardless of surface.
- Cost: review doubles agent-tokens on the reviewed change
  (build-time: affordable per doctrine; product-time: budget
  it). Trivial changes batch-review; the scope line keeps
  ceremony proportional.
