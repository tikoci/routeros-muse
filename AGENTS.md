# routeros-muse — agent entry

Local git repo for the RouterOS network workspace + web UI.
(History: staged in ~/Work, landed here at T14.)

## Start here

1. `README.md` — owner-facing: what it is, CLI, workspace idea.
2. `records/` — the tracker. `make plan` (ordered work), `make check`
   (validate before claiming an update). needs/tasks/decisions/concepts TOML.
3. `docs/internals.md` — how the pieces fit; `docs/design/` — design notes.
4. `SECURITY.md` — security facts and known gaps (grows as we learn).
5. `CONTRIBUTING.md` — issues vs records, PR/merge rules, releasing.

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

## Debugging a live session (outside the repo)

- Muse session logs: `~/.local/share/muse/sessions/YYYY/MM/DD/<session-id>/session.jsonl`
  (one JSON event per line; newest dir = latest chat). Useful
  `payload.event.kind` values: `assistant_tool_calls_committed`
  (calls + args), `tool_result_batch_committed` (outputs),
  `requested`/`decision_applied` (approvals, per pipeline stage),
  `skill_read_observed`; top-level `payload_type`
  `runtime.approval_reconfigure` marks an access-mode switch.
- Per-workspace muse home: `~/.local/share/routeros-muse/.muse-config/<name>-<id>/muse/`
  (`approval-policy.json` = seeded + owner-approved rules,
  `skills/` = staged routeros-skills).
- Test workspaces under `scratch/` sit inside this repo, so the
  agent can wander `../..` into our source and root AGENTS.md.
  A real owner workspace has no parent repo; weigh findings that
  depend on that.
- Access mode and the startup sandbox override decide what a session
  can reach. Ask first normally runs the shell sandboxed: no direct
  sockets (native API, SSH, MAC-Telnet,
  MNDP, ping fail as EPERM or instant refused), and REST only via
  muse's proxy, which resets Basic-auth requests (T157). Allow all
  is unsandboxed. T171 adds Settings → Disable sandbox (default off):
  stop/start routeros-muse to apply it while keeping Ask first command
  approvals. This removes filesystem and network isolation, including
  host restrictions. Settings shows the running state and pending restart.
  T156's full transport matrix remains open. Never read "every port
  refused" under sandboxed Ask first as a router fault.
- Read the log before trusting an agent's self-report. Its write-up
  of a session can misattribute causes (sandbox read as router
  state) or credit itself with steps the owner prompted.
- Records written in a session show up as CDB warnings later
  (`cdb/unknown-option: note` came from an agent's
  `devices set note=`; centrs has no such key, C25).

## Gating on the developer's Mac

`make gate` is red there at HEAD for environment reasons (T155):
put the bundled centrs first (`PATH="$PWD/node_modules/.bin:$PATH"`,
the global `~/.bun/bin/centrs` can be stale), and compare any
failures against the T155 list before calling one new.
