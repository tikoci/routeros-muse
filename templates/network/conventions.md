# Conventions — the rules of this house (one page)

## Ownership (per directory, never two-way)

- Agent-owned (`router.toml`, `inventory/`, `operations/`, `work/`,
  `.agents/skills/`, `reports/`, `decisions.md`, docs): canonical HERE. Edit freely.
- Router-owned (pulls under `observations/`): read-only evidence.
  Never edit a pull — re-pull, or fix the router.
- One home is canonical (`workspace.toml`). Second copies carry age
  manifests and are reference, never merged back.

## Drift (plan vs capture)

Disagreement between intent and observation goes on
`operations/drift.md` or the router gets fixed. The plan is never
rewritten to match unless that is the recorded decision, with an owner.

## Capture boundary

- IGNORE (local-only): raw pull dirs `observations/*/pull-*/`.
- COMMIT: redacted `observations/<device>/summary.md` (device, times,
  file list + sizes + statuses, checker verdict — no serials/secrets).
- The summary is the pointer to where more detail lives.
- Override (documented, on request only): raw observations may enter
  git for multi-agent sharing across systems, ONLY redacted to the
  summary standard first. The agent states the caveat when asked and
  never volunteers the override.

## Branching and issues

- Commit to `main`. Pull requests only on explicit owner request,
  never suggested — they offer single-or-few-user systems nothing.
- Issues are intake: converted into repo items (proposal, decision,
  incident record) and closed as done.

## Claims and checks

- Every claim carries command + output. Unrun is pending.
- Observations carry device/source/time. Reports cite data + time.
- A failed check never renders green. Freshness splits three ways:
  content-changed vs last-observed vs last-attempted.

## Sensitivity (privacy tiers)

- Travels: lab device naming, hardware models, MAC addresses,
  private IPs, software keys.
- NEVER travels: people's names, locations, public IPs, credentials,
  secrets, hardware serials, or anything hinting at those.
- Before the first push anywhere shared: grep the diff for the
  never-list. When in doubt, ask before writing.

## Sessions

- Open: sync canonical, pull fresh, run the checker, read ages.
- Close: commit shaped work, refresh summaries, leave the tree clean
  except ignored pulls — the next session reads `inbox/` + the last
  summary and knows exactly where things stand.
