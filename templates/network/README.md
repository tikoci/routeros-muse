# Network workspace template (v1)

This is a prepared directory for running a network as a filesystem:
one canonical home for the plan, the observations, the decisions, and
the reports — plus the conventions and skills an agent needs to work
in it. No bridge, container, or tunnel required; those are deployment
options for when circumstances require them, never prerequisites.

## Instantiate (N=1 start)

1. Copy this tree to the new home (private git repo, local dir, or
   router disk — see `.agents/skills/` for the home guides).
2. Edit `workspace.toml`: home type, repo URL, tool pins, backup record.
3. Edit `router.toml`: your one box (site-location-role id, label on
   the unit; serial binds at unbox, never before).
4. Run the first pull into `observations/`, run the checker (`checks/`),
   write the first `summary.md`.
5. First commit is plan/skills/schemes/docs only — no pulls, no
   secrets, no lab identifiers past your privacy line.

One router plus one observations folder is a complete workspace. Grow
only when a second box or a second human appears.

## Map

- `START-HERE.md` — the owner's first read (5 minutes).
- `AGENTS.md` — the agent's first read; points here, does not replace it.
- `workspace.toml` + `workspace-schema.md` — what this setup is.
- `conventions.md` — ownership, drift, capture boundary, branching.
- `router.toml` — the one box (N=1). `inventory/` — grows past N=1.
- `device.cdb` — the device registry (centrs; addresses, users,
  secrets). `devices.toml` — its generated, read-only text mirror.
- `observations/` — pulls + redacted summaries. Raw is local-only.
- `operations/` — proposals, drift list, deployment log.
- `work/` — agent-generated code/projects, one dir each, linked.
- `checks/` — how to run the checker; verdict log.
- `reports/` — views that cite data + time.
- `decisions.md` — the decision log (id/date/title/decision/why).
- `.agents/skills/` — home guides + lifecycle workflow (load on demand).
- `inbox/` + `whiteboard/` — unshaped work, no formality tax.

## Rules that hold everywhere

- One canonical home; second copies carry age manifests, never sync back.
- Agent-owned source is canonical here; router-owned pulls are read-only
  evidence — never edit a pull, re-pull or fix the router.
- Plan-vs-capture disagreement goes on the drift list or the router gets
  fixed; the plan is never silently rewritten to match.
- Commit to `main`. Pull requests only on explicit request, never suggested.
- Issues are intake: converted into repo items, closed as done.
- Every claim carries command + output. A failed check never renders green.
