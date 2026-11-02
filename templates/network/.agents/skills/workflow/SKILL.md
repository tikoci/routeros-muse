---
name: workflow
playbook: false
description: "Network lifecycle workflow: buying, setup, configuring, troubleshooting, reports, plus the thin GitHub adapter. Use when: running any lifecycle stage, promoting unshaped work, or mapping issues and PRs onto repo records."
topics: [lifecycle, github]
tested: none
---

# Lifecycle workflow (buying → setup → configuring → troubleshooting → reports) [template v1 draft]

How git-native schemes (issues/PRs) map onto the network-as-filesystem:
workspace files stay canonical, GitHub is a thin projection.

## 0. Principles (no new doctrine; all inherited)

- Records stay canonical. Unshaped work lives in
  `inbox/`/`whiteboard/` with no formality tax; promotion to tracked
  work needs an owner plus a definition of done. GitHub issues/PRs are
  a thin projection, never the store.
- The portable core runs on files alone. Single-copy and router-disk
  homes execute the whole lifecycle with zero GitHub.
- Free-tier-safe (live-verified 2026-10-28). The workflow uses
  only repo + issues + PRs-as-proposals + labels + plain history. No
  protected branches, required reviewers, code owners, or private
  Pages; no Actions at N=1.
- N=1 zero ceremony. One `router.toml` plus one `observations/`
  folder grows only when a second box or a second human appears.
- Per-directory ownership, never two-way sync. Agent-owned
  source is canonical in git; router-owned pulls carry age manifests
  and are never edited in place.
- Privacy default: raw pulls are local-only and
  git-ignored; only redacted summaries may commit.

## 1. Portable core: states and promotion

| State | Lives in | Formality |
|---|---|---|
| Unshaped idea/question | `inbox/`, `whiteboard/` | none; draft freely |
| Shaped proposal | `operations/<id>-*.md` | owner + definition of done required |
| Decision | decisions record (id/date/title/decision/why) | written once, outlives chat |
| Observation | `observations/` pull + manifest, checker-clean | device/source/time/completeness |
| Disagreement | drift list | plan vs capture; fix the router or decide, never silent plan rewrite |

Promotion rule: anything may sit unshaped forever. The moment it needs
someone to do something, it gets an owner and a DoD and becomes shaped.
GitHub mirrors shaped-and-above only; unshaped never becomes an issue.

## 2. Lifecycle walkthrough

### Buying

1. Draft the need in `whiteboard/<topic>.md`: constraints, budget,
   site facts. Cite rosetta product/device tables where they answer;
   mark anything rosetta-backed with the DB identity until full
   coverage lands.
2. Decide: append a decisions record; the whiteboard draft links to it.
3. GitHub adapter (optional): one `buying`-labeled issue holding the
   question; closed by the commit that lands the decision record.

### Setup / unbox (provisioning, not management)

1. Device first: device ID names the job (`site-location-role`); the
   label is what is on the unit; the serial binds hardware to device at
   unbox, sticker photo where that pipeline exists.
2. Land `inventory/<device>.toml`, run the first pull into
   `observations/`, run the checker. Record the import path
   explicitly when the network already exists: pull first, adopt
   captures as observations, then write the plan from observed state —
   the one allowed plan-from-capture direction, and only as a decided
   import step.
3. GitHub adapter: one `setup`-labeled issue per device as intake; the
   inventory-plus-observations commit lands on `main` and the issue
   closes when the box is accepted. PR shape only on explicit request.

### Configuring

1. Write the intended change as a shaped proposal under `operations/`
   (owner + DoD + which drift entries it resolves).
2. Run the checker; confirm the drift list shows the intended delta
   and nothing else.
3. Apply via the staged-script path under human login with the
   `/system/note` WIP flag set before multi-step work and cleared
   after (empty means well).
4. Re-pull, confirm the drift entries clear, close the proposal with
   the pull manifest cited.
5. GitHub adapter: the proposal lands as a commit on `main`; a linked
   issue (if any) is intake — converted to the proposal record and
   closed on apply. PR shape only on explicit request.

### Troubleshooting

1. Pull, compare, and open an incident record under `operations/`
   with the failing observation cited (manifest + time) and a
   command/output/environment ledger attached.
2. Bisect on a twin first; every twin result states its limits
   (no radios, x86 package gaps). Observed vs inferred links are
   marked separately.
3. Look-after cadences stay split (collect/investigate/notify):
   notify on change only, announce recovery, and a failed check never
   renders green.
4. GitHub adapter: one `incident`-labeled issue per incident as
   intake, converted to the incident record; the fix commit references
   it; closure cites the clearing pull.

### Reports

1. Write `reports/` views that cite data plus time; a view never
   outruns its freshest cited observation (freshness split:
   content-changed vs last-observed vs last-attempted).
2. Notify on change only; periodic summaries are just dated views.
3. GitHub adapter: a periodic summary lands as a commit or note;
   issues are filed only on drift/incident, never per report.

## 3. GitHub adapter (thin by design; decided 2026-10-28)

- Labels (the whole taxonomy): `buying`, `setup`, `config`,
  `incident`, `report`. Documented in the repo conventions file.
- Issues are INTAKE: converted into items in the repo (proposal,
  decision, incident record) and closed as done. An open issue is a
  pointer to repo state, never the state itself.
- PRs are used ONLY on explicit owner request, never suggested —
  they offer single-or-few-user systems nothing, and the template
  starts simple. There is no GitHub-side state that cannot be rebuilt
  from the repo: no Projects boards, no required reviews, no wikis.
- GitHub never holds secrets, raw pulls, or canonical state. If the
  repo vanished from GitHub but the files survived, nothing of record
  is lost.
- Actions are out of scope at N=1. The allowed future step is
  checker-on-push inside the 2,000 min/mo Free budget, advisory only,
  never merge-gating.

## 4. Owner-repo bootstrap checklist

One private repo per network (split per site only when a second site
forces it), instantiated from the starter layout:

1. Clone or init the layout: START-HERE, `workspace.toml`,
   `inventory/ observations/ operations/ checks/ .agents/skills/ reports/
   inbox/` plus `whiteboard/`; instantiate only what is useful.
2. `workspace.toml` declares the canonical home and pins the trilogy
   versions the repo was built against.
3. `.gitignore` ignores raw pulls and captures; the conventions file
   states the boundary (proposed: raw pull outputs local-only,
   redacted summaries may commit — exact filenames still open).
4. Conventions file states per-directory ownership, the
   no-edit-pulled-copies guard, and the drift-list rule.
5. Create the five labels; confirm issues are on and wikis/Projects
   are off or ignored.
6. Point START-HERE at the entry skill + capability probe so a
   fresh session orients before touching anything.
7. First commit is plan/skills/schemes/docs only — no pulls, no
   secrets, no lab identifiers.
8. Before any shared push, apply pre-publish-scrub:
   low-sensitivity identifiers may travel; high-sensitivity
   identifiers and clues never travel.
