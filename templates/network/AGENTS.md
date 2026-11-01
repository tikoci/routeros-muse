# AGENTS.md — agent entry (read this first)

You are in a network workspace: a directory that is the network's
memory. The router runs the packets; this tree holds the plan, the
observations, the decisions, and the reports. Work the way the owner
would: read first, change through proposals, leave evidence.

If you are the owner (human), start at `START-HERE.md` instead.
This file is the well-known spot agents look for; it points at the
owner docs, it does not replace them.

## First five minutes

1. Read `START-HERE.md` (owner context) and `conventions.md` (the
   rules of this house — one page, binding).
2. Read `workspace.toml` and `router.toml`. Confirm they describe
   THIS setup before trusting anything else in the tree.
3. Check capability before promising execution: shell present?
   `quickchr`/`centrs`/`rosetta` on PATH at the pinned versions?
   Twin or LAN router reachable? State your mode plainly —
   full (local execute), design-only (edit plan/proposals, no
   pulls), or viewer (read + approve). Unprobed is design-only.
4. Pull fresh, run the checker (`checks/`), read `inbox/`, any
   `operations/*-handoff.md` waiting for local execution, and the
   last `observations/<device>/summary.md`. Then make your first
   statement: one true sentence citing data + time.

## Where things live

- Plan: `router.toml`, `inventory/`. Reality: `observations/`.
- Work: `operations/` (proposals with owner + definition of done).
- Generated code/projects: `work/` (see `work/README.md`).
- Proof: `checks/`, `reports/`, `decisions.md`.
- Guides: `skills/` — load on demand, never all at once. Start with
  the skill matching the `workspace.toml` home type, plus
  `network-workspace-bootstrap` for layout/handoff questions.
- Unshaped thought: `inbox/` or `whiteboard/` — no form, no tax.

## Hard rules

- Every claim carries command + output. Unrun is pending.
- Never edit a pull under `observations/`. Re-pull, or fix the router.
- Plan-vs-capture disagreement goes on `operations/drift.md`.
  Never silently rewrite the plan to match a capture.
- Secrets, passwords, tokens, and hardware serials never enter
  committed files. Raw pulls stay local; only redacted summaries travel.
- Router writes need explicit owner go-ahead per item. Twins are free.
- Commit to `main`. Pull requests only on explicit owner request.
- Close clean: commit shaped work, refresh summaries, leave the tree
  clean except ignored pulls. The next session reads `inbox/` + the
  last summary and knows where things stand.
