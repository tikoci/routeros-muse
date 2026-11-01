# START-HERE — your network, as files (5 minutes)

This directory IS your network's memory. The router runs the packets;
this tree holds the plan (what should be), the observations (what is),
the decisions (why), and the reports (what happened). An agent works
here the way you would: read first, change through proposals, leave
evidence.

> Agent? Your entry is `AGENTS.md` in this directory. It points back
> here for owner context; read both, in that order.

## The three ideas

1. **Plan vs reality, side by side.** `router.toml` says what the box
   should be. `observations/` holds dated pulls saying what it is.
   When they disagree, the disagreement goes on a visible list
   (`operations/drift.md`) — it never gets quietly papered over.
2. **Evidence, not vibes.** Every observation carries device, source,
   and time. Every report cites the data it is built from. Every
   claim an agent makes should come with the command and output.
3. **Ceremony grows with need.** One box and one human: commit to
   `main`, keep it simple. A second box or human is what earns
   branches, reviews, and process — not before.

## Your first session

1. Read `conventions.md` (one page — the rules of this house).
2. Confirm `workspace.toml` and `router.toml` describe YOUR setup.
3. Pull the box, run the checker (`checks/`), read the summary.
4. Unshaped thoughts go in `inbox/` or `whiteboard/` — no form, no tax.
   Anything needing action becomes a proposal under `operations/`
   with an owner and a definition of done.

## Where things live

Plan: `router.toml`, `inventory/`. Reality: `observations/`. Work:
`operations/` (proposals) and `work/` (agent-built code/projects).
Proof: `checks/`, `reports/`, `decisions.md`. Guides: `skills/`
(your agent loads these on demand — start with the one matching
this home). Agent entry: `AGENTS.md`.

## What never happens here

Secrets, passwords, tokens, and hardware serials are never written
into committed files. Raw pulls stay on the machine that took them;
only redacted summaries travel. When in doubt, ask before writing.
