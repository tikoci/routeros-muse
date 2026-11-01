# operations/ — work with an owner and a definition of done

Anything may sit unshaped in `inbox/` or `whiteboard/` forever. The
moment it needs someone to DO something, it comes here with two
mandatory fields: **owner** and **definition of done**. No owner or no
DoD means it is not shaped yet — send it back, don't file it.

## proposal shape (one file per item, `<id>-<slug>.md`)

- id / title / owner / status (shaped/active/done/dropped)
- definition of done (observable, checkable)
- drift entries it resolves (if any)
- ledger: commands + outputs + where they ran
- closed by: the pull/summary/commit that proves it, with time

## handoff shape (`<id>-handoff.md`, a proposal variant)

A design session without local execution (e.g. a cloud VM) hands
work to a local agent session through this file — never through
chat alone. Same fields as a proposal, plus:

- origin: which session/harness wrote it, and its capability mode
- every claim labelled `unverified (design)` until a local run
  supplies command + output on a twin, then the box
- pickup: the local session globs `operations/*-handoff.md` +
  `inbox/` at open, restates its own capability mode, then
  executes, or records why a step cannot run there

## drift.md — the disagreement list

Plan (`router.toml`/`inventory/`) vs captures (`observations/`):
every live disagreement is an entry here or the router gets fixed.
Entries cite the pull manifest + time. The plan is never rewritten to
match unless that is the recorded decision, with an owner.

## deployments.md — the served-artifact log

Editing source never proves deployment. Every deploy records:
artifact, version/hash, time, target path, reload action taken, and
the read-back proof (served-bytes hash equals source hash). No
read-back proof means not deployed.
