---
name: home-private-git
description: "Default network home: private git repo. Use when: bootstrapping the owner's repo, first session in a fresh clone, promoting single-copy to git, capture-boundary questions, or before the first push to a shared remote."
topics: [git, github, workspace, sync]
requires: [git]
tested: self-test
---

# `home-private-git` skill (default home) [template v1 draft]

Vendored from the build notes for review with template v1. Build-tracker
references (T/K IDs, notes paths) are pointers pending staging scrub.
Recipe contract: trigger/prereqs/access/envs/outputs/verification/
recovery/limits. Device names are roles (site-location-role), never
serials or addresses. No secrets below.

## Part 1 — The checklist (setup → session loop)

### 0. Decide this is the home

Use private git when the owner has (or accepts) a GitHub account and the
agent machine reaches the network. Otherwise fall back: router disk
(`home-router-disk-sync`, `home-router-container`) or single copy
(`home-single-copy`) — sibling skills, not yet written. Drive is never
the live home (`anti-drive-live`).

### 1. Bootstrap the repo (once per network)

1. Create ONE private repo per network (split per site only when a
   second site forces it). Confirm: issues on; wikis/Projects off or
   ignored; no paid gates of any kind.
2. Lay out the starter skeleton (K2), instantiating only what is
   useful (K10 — N=1 starts with one `router.toml` plus one
   `observations/` folder):
   `START-HERE`, `workspace.toml`, `inventory/ observations/ operations/
   checks/ skills/ reports/ inbox/` plus `whiteboard/`.
3. `workspace.toml` declares the canonical home (`home = "private-git"`,
   plus repo URL) and pins the trilogy versions the repo was built
   against. This is the proposed answer to T21 open Q2.
4. Write `.gitignore` with the capture boundary (D2/Q4 decided
   2026-10-28 — raw pulls local-only, redacted summaries committable):
   - IGNORE: `observations/<device>/raw/` (export text, volatile-stripped
     JSON, full manifest with serial — mirrors prototype `out/<device>/`
     in pull/README.md; standing rule bans committing serials).
   - COMMIT: `observations/<device>/summary.md` (device, times, file list +
     sizes + statuses, checker verdict — no serials, no secrets). The
     summary is the pointer to where more detail lives.
   - Documented OVERRIDE: an owner may ask for raw observations in git
     (e.g. multi-agent sharing across systems) — allowed only with the
     content redacted/changed to the summary standard first. The agent
     states the caveat when asked; it never volunteers the override.
5. Write the conventions file: per-directory ownership (agent-owned
   canonical here; router-owned pulls carry age manifests, never edited
   in place), the no-edit-pulled-copies guard, the drift-list rule (K8).
6. Create the five labels: `buying`, `setup`, `config`, `incident`,
   `report` (T24 strawman §3).
7. Point START-HERE at the entry skill + capability probe (T15) so a
   fresh session orients before touching anything.
8. First commit is plan/skills/schemes/docs only — no pulls, no
   secrets, no lab identifiers past the D1 line. Scrub before the
   first push to anything shared (D1 still open).

### 2. Branching rule (N=1 zero ceremony; D2 decided 2026-10-28)

- Commit to `main`. No PRs against yourself — that is ceremony
  without a reviewer — and the agent does NOT suggest PRs even when a
  second human or agent appears: PRs offer single-or-few-user systems
  nothing, and starting complex is the wrong call.
- PR mechanics are used ONLY if the owner explicitly asks. An owner
  asking a question may evolve their own scheme afterward; the
  template does not start them there.
- No protected branches or required reviewers ever (Free-tier ban).

### 3. Session open

1. `git pull` (or confirm single-copy canonical — K12, one home only).
2. Pull router-owned dirs fresh where they exist (sibling skill flow);
   land raw captures under `observations/<device>/raw/` (ignored).
3. Run the checker over captures (K5; prototype: `bun checker.ts
   --all --out observations`, one JSON line per device, exit 0 clean).
4. Read manifest ages with the freshness split (K6): content-changed
   vs last-observed vs last-attempted — healthy data never looks stale.

### 4. Session close

1. Write or update shaped records (owner + DoD, K15): proposals,
   decisions, incident entries, report views citing data + time (K3).
2. Refresh `observations/<device>/summary.md` from the verified pull;
   never hand-edit `raw/`.
3. Commit shaped work and push to `main` (§2). PRs only on explicit
   owner request, never suggested.
4. Leave the tree clean except ignored `raw/` — `git status` shows the
   next session exactly what is uncommitted thought vs unshaped draft.

## Part 2 — Skill doc

### Trigger

Load when: bootstrapping the owner's repo; first session in a fresh
clone; promoting a single-copy home to git; any question about what
commits vs what stays local; before the first push to a shared remote.

### Prereqs

- git on PATH; owner GitHub account exists; agent git identity set
  (name/email per deployment — identity provisioning itself is a T21
  open con, assumed solved by the owner step below, Part 3.1).
- Agent machine has the trilogy (quickchr/centrs/rosetta) and the
  pull/checker recipe for captures. No router-side software required.
- D1 posture known for this repo: what scrub level the first push
  needs (default until D1 closes: own-lab content minus credentials
  stays unpushed to anything shared).

### Access

- Reads-first everywhere: pull + checker before any write, same as
  every home.
- The bigdude rule generalizes: writes to a production router need an
  explicit go-ahead per item, whatever home holds the plan.
- Git writes: local commits are cheap and free; push to a shared
  remote and merge of someone else's PR need the owner's ack once a
  second human exists (branching rule §2).
- Operator Unknown → ask before any write (K14).

### Envs

| Name | Use |
|---|---|
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | commit identity for agent-authored commits |
| `GIT_SSH_COMMAND` | key selection where the deployment needs it (path only, never material) |

No tokens, passwords, or CDB material in env for git purposes. The
agent's repo credential is provisioned by the owner at bootstrap
(Part 3.1) and lives in the deployment's own store, never in the repo.

### Outputs

- Bootstrap: repo URL + initial commit SHA recorded in `workspace.toml`
  provenance (or the coord post that announces the home).
- Per session: shaped commits (proposals/decisions/incidents/reports),
  refreshed `summary.md` files, checker verdicts cited by device + time.
- Promotion events: issue↔record links where the GitHub adapter is in
  use (T24 strawman §3); the record is always findable without GitHub.

### Verification

- `git status --short` shows only intended changes; `raw/` never
  appears (ignore rule holds).
- Checker exit 0 over every device worked this session; any nonzero is a
  finding, never rendered green (K20).
- Every `summary.md` cites its pull time and checker verdict; every
  report view cites data + time (K3).
- No serials, creds, tokens, or addresses in `git log -p` for the
  session's commits (standing rule; grep before push).
- Claim discipline: every claim carries command + output (K23).

### Recovery

- Dirty/conflicted sync: the canonical home wins (K12); second copies
  carry age manifests. Re-pull router-owned dirs; never push agent
  edits into router-owned paths.
- Bad commit: revert with a new commit (history is the audit trail);
  never rewrite pushed history on a shared repo.
- Checker nonzero: treat as drift/incident input (strawman §2), not as
  a reason to hand-edit `raw/` — captures are evidence, fixed by
  re-pull or by fixing the router.
- Credential loss: stop, escalate to the owner for re-provisioning
  (Part 3.1); never improvise a credential or embed one to unblock.

### Limits

- Free-tier ceiling (T21): no branch protection, required reviewers,
  code owners, private Pages, wikis-as-record. Advisory
  checker-on-push inside 2,000 Actions min/mo is the only allowed
  future step, never merge-gating.
- Offline owners cannot use this home — that is what `home-single-copy`
  is for, with git promotion when connectivity exists.
- This skill covers the git side only. Router-disk homes, container
  deploy-and-read-back, and the Drive anti-pattern are sibling skills.
- `centrs check` reach/health battery is designed, not implemented —
  the session-open probe above is the manual version until it lands.

## Part 3 — Assumptions (D2/T13 ratify; this skill assumes)

1. Owner provisions the agent's repo credential at bootstrap and owns
   rotation; the skill never designs credential storage.
2. `workspace.toml` gains `home`, repo URL, and trilogy pins (T21 Q2
   proposed answer); T13 owns the schema.
3. Capture boundary as §1.4 (T21 Q4 proposed answer); D1 may tighten
   it (e.g. summaries also local-only for some deployments).
4. Second-machine/second-agent appearance is the promotion trigger
   from main-only to branch+PR (T21 Q6 proposed answer for workflow).
5. The coord room (Gmail Drafts) is BUILD scaffolding only — habitat
   interchange while building, until routeros-muse itself is on GitHub.
   It is NOT part of the offering and NEVER an owner workflow (D2/Q5
   decided 2026-10-28). Owner cross-session continuity is the repo
   itself (plus file-provider homes once listed).
