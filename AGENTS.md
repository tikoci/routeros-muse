# routeros-muse — agent entry

Local git repo for the RouterOS network workspace + web UI.
(History: staged in ~/Work, landed here at T14.)

## Start here

1. `README.md` — owner-facing: what it is, CLI, workspace idea.
2. `records/` — the tracker. `make plan` (ordered work), `make check`
   (validate before claiming an update). needs/tasks/decisions/concepts TOML.
3. `docs/internals.md` — how the pieces fit; `docs/design/` — design notes.

## Conventions (binding)

- Track in `records/*.toml`, never in prose. Update the record in the
  same step that does the work; `make check` must pass.
- Claim work before starting (`agent` = you, status `active`).
  Unclaimed READY items are fair game.
- The human is the developer; router owner/operator is the end user.
- Gate before done: `make gate` (biome + tsc + suite + browser smoke)
  and `cd records && make check`. Zero or it is not done; lint
  findings get fixed, not suppressed. Gates must earn their keep: a
  gate that never fails is ceremony — remove it (D28).
- Sweep before handoff: anything beyond a trivial repair gets a full
  click-through of the real surface in every mode (not just the
  touched slice), with the browser console clean. Eyeball the shots.
- Track or fix: everything the sweep surfaces is fixed or filed as a
  task/decision in the same turn — never prose-only, never carried
  silently. Design questions go to the developer as open decisions.
- Ground, don't guess: stop the track and fan out (subagents, live
  probes) the moment a claim needs verification against a real
  system. Wire shapes come from wire captures, never memory.
- quickchr is grounding, not replication (D36): prove claims on a
  disposable CHR. bigdude: reads free, ANY write asks the developer first.
- Sibling checkouts, not foreign deps: quickchr/centrs/rosetta live in
  `~/Projects/tikoci` — file the need in `records/needs.toml`, fix it
  there, consume it here via `@next` pins. Never fork, never work
  around silently; a workaround ships only with its upstream issue
  linked in the task evidence.
- Upstream fixes go upstream as PRs (issues first, comment don't duplicate).
- Privacy (D1): low-sensitivity (models/MACs/private-IPs/sw-keys) may
  travel; high-sensitivity never: creds, tokens, serials, public IPs,
  people, locations. Captures (`out/`) stay local, never committed.
- Claim = command + output. Unrun = pending.

## Map

- `src/` + `tests/` — CLI (`src/index.ts`), server, MSP client, render jobs
- `templates/network/` — starter workspace (conventions, skills, checks)
- `tools/` — skill gate, UI smoke, router capture + checker
- `records/` — needs/tasks/decisions/concepts + query tool
- `docs/` — internals, design notes, UI concept mockups
