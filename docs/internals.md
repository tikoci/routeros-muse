# Internals

How the pieces fit. Owner-facing summary lives in `README.md`;
design history in `docs/design/`.

## CLI (T93, D35)

Bare `routeros-muse` is `start`: serve the directory (default: cwd)
when it is a workspace and open the browser, else offer init-here /
registry pick / browser picker on a TTY (off one: no-workspace mode
for the cwd default, abort with the init line for a named dir). `serve` aliases `start`; `start --tui` aliases `code`. `init
[dir] [--template minimal|network]` scaffolds in place, never
overwriting, and registers the workspace. `code` runs the Mode A
steps below, then execs `muse` with the package bundle on PATH;
every arg but `--yes`/`--router`/`--print-only` passes through to
`muse` verbatim and in order (`--` forces the rest); the dir slot
closes at the first muse arg, so a flag's value never becomes the
workspace. `doctor` runs the same steps
print-only and exits 1 when a required item is missing. Fleet reads
left this CLI with the `devices` subcommand (T93): `centrs`
owns them now.

## Code + doctor (Mode A steps)

`code [dir] [muse args...] [--yes] [--router H[:port]]
[--print-only]` per `docs/design/t29-handoff-bootstrap-design.md`
(Final, D20). Checks the machine, pins the trilogy, checks `muse`,
opens/validates the workspace, runs the capability probe, picks up
`operations/*-handoff.md` + `inbox/`, and execs `muse` in the
workspace. Nothing installs without asking. `doctor [dir]` runs the
same steps print-only: never installs, never prompts, never execs.

```sh
make test   # anchor suite (see gate output for current counts)
```

`dir` defaults to the cwd; an explicit git URL still clones (target
defaults to `./<repo>` off a TTY, prompted on one). `--yes` is the
one-yes for echoed user-level installs; `--print-only` prints the
launch line instead of exec'ing it. `--yolo` is not a code flag: it
passes through to `muse` like any other unknown arg (on `start` it
is ours: the session's most permissive approval mode).

Steps (T29 §4 order):

1. Prereqs: bun, git, os/arch; qemu/kvm optional (absence degrades,
   never fails).
2. Trilogy: detect installed quickchr/centrs/rosetta.
3. Agent: `muse` present? If missing, attempt the official user-level
   installer echoed under the one-yes (mac/linux; Windows is
   print-only), else print-and-stop with a resume line. If present
   but showing no login, print `muse`'s own auth flow and stop.
4. Workspace: clone or open, then validate (parses, canonical,
   AGENTS.md, conflict-copy guard).
4b. Pins: `[pins]` vs the package bundle (D26). Unpinned entries block
    with a named TODO; mismatches stop with refresh-or-re-verify
    remedies plus the resume line. Nothing installs globally.
5. Probe: twins (`quickchr doctor --json`), LAN (`centrs discover`
   MNDP, plus `--router` TCP probe), packaged + workspace doctor
   spec. Prints the mode: full / twin-only / real-box-only /
   design-only.
6. Handoffs: newest-first list with owner/status/DoD, then the exact
   launch line.

`twin-only` (twins yes, LAN no) is a fourth edge the contract's three
modes do not name; it is reported, not folded into a wrong mode.

## Tool resolution (T51, D26)

package.json owns the trilogy versions (`@tikoci/quickchr`,
`@tikoci/centrs`, `@tikoci/rosetta`, all on the `next` channel during
preview). The bootstrap and server front the package's own
`node_modules/.bin` on PATH for every trilogy spawn — UI
subprocesses, probes, and agent children (Mode A launch and MSP
spawn) alike — so all sides resolve the identical builds. The
workspace `[pins]` is the per-setup verified-against record: when the
running bundle differs, the bootstrap stops with refresh-or-bump
remedies, never a global install. `/api/status` reports the bundle
source, dir, and detected versions.

## Server (Mode B)

`serve` starts a Bun server over the workspace, bound to 127.0.0.1 by default; `--host` overrides the bind address (no other network restriction exists).
`src/msp/client.ts` drives `muse serve` over stdio JSONL
(single-flight host init — page load races once split the drive
grant); `src/serve/server.ts` bridges chat (send/history/SSE stream),
tree, recents, files (TOML validate-before-save), devices (router.toml
devices; live stats need a bound host), twins, alerts, and past chats;
history carries structured transcript rows (toolCall/subagent cards
with raw-text fallback) and live SSE rows ride the same mapper, with
tool output/diff bodies openable in middle tabs via item/readOutput
(T37); `src/serve/ui.html` is the v10 concept live-wired (no demo
content). Providers: `meta` default, `echo` for hermetic tests. Brand
row carries the production MikroTik symbol + Meta mark (T35). T40
split the UI-agnostic reads out of the server into
`src/lib/workspace.ts` (tree/recents/files/alerts/artifacts) and
`src/lib/fleet.ts` (devices/stats/twins); the routes are thin
wrappers over those modules.

Render services (T33 done): `src/render/jobs.ts` runs named jobs into
`<workspace>/reports/render/<job>-<stamp>/` with source + time
(`job.json`). Topology splits by context per D21 (web: mermaid .mmd +
HTML; CLI: DOT + `dot -Tsvg`, text fallback); report renders markdown
to self-contained HTML. Map/chart have defined contracts and honest
not-built errors. Served via `POST /api/render` + `GET /api/artifact`.

## Templates (T93)

`templates/<name>/` is the single init source: `template.toml`
(name, description, version — never copied) plus the files to copy.
The scaffold copies recursively, substitutes `{{name}}` in
`*.toml`/`*.md`, stamps a `[template]` provenance table into the new
`workspace.toml` (a record, never enforced), then runs `centrs
devices init`. `minimal` is the runnable minimum the UI populates
from; `network` is the full starter. Both scaffold and pass
workspace validation; templates resolve via the package root so
bunx/npm installs find them. The picker create flow and `init`
share this path (`scaffoldWorkspace` for create-at-default,
`scaffoldIntoDir` for init-in-place with its never-overwrite
conflict list).

## Workspaces registry (T40)

Serving a workspace registers it (`add/list/prune`, entries carry
`{name, path, added, lastOpened}`) in
`$XDG_DATA_HOME/routeros-muse/registry.toml`. State, not config: the
registry is regenerable runtime state (serving re-registers), so it
lives under the data home beside muse's own homes, never beside user
config; `XDG_DATA_HOME` stays overridable so tests isolate
hermetically. No-workspace mode offers the picker (Workspaces tab):
registry entries with liveness, open-in-place, prune, and
create-at-default. New workspaces land in `~/Networks` — one
predictable path on every OS (no user-dirs parsing, no per-OS
special cases), and machine-managed network trees stay out of the
documents clutter. Opening is a restart: serve binds its root at
boot, so the picker prints the exact `serve` line instead of
pretending to switch live. Creation scaffolds from the template
select (minimal default, network full), stamps `[template]`
provenance, writes `device.cdb` via `centrs devices init`, and
steers to WinBox encryption until C14. The T64 missing-CDB overlay
now points at the real setup: the exact init command in workspace
mode, the creation flow otherwise.

## UI smoke (T43 standing rule)

Every UI slice extends `tools/ui-smoke.ts` and runs `make smoke`
before done. Hermetic: temp workspace + temp muse home, echo
provider, real server in-process, playwright chromium. Asserts page
load, zero unexpected console errors, a real composer roundtrip,
card rendering via the `window.__smoke` hook, open-in-tab wiring,
the diff renderer, the lock/unlock/bypass/missing auth legs, and
the no-workspace picker (list/open/prune/create); screenshots land
in `out/ui-smoke/` for eyeballing. First run needs the browser once:
`bunx playwright install chromium` (pinned `playwright` devDep).
Not part of `bun test`: browsers are too slow/flaky for the unit
suite, so the smoke stays a separate explicit gate.

Known follow-ups: meta-provider demo run (compact/mention/tool-write);
agent-driven CDB add flow for brand-new device hosts (T48 modal covers
set/add-on-existing); capability-mode pill wiring; subagent
child drill-down (cards show the summary inline); map/chart renderers.

## Doctor spec (D15/D20)

`doctor.toml` ships with the package (Mac first; windows/linux real
detects, stub-grade hints). A workspace may add `doctor.local.toml`:
same `[[tool]]` shape, same id+os overrides, new ids append. Tiers
are contextual: base `tier` plus `required_for` (skills that escalate
the tool to required-for-this-skill). Missing `required` blocks the
bootstrap; the rest is reported with hints.

## Unlock (T64)

The CDB password never leaves the server process except into child
envs. `/api/auth/unlock` binds `{cdbFile, password}` to the session
token; UI centrs calls and the MSP worker spawn under one explicit
per-worker environment (`workerEnv` over the bundle env above)
carrying `CENTRS_CDB_FILE` plus the session's
`CENTRS_CDB_PASSWORD` — never ambient globals, never `process.env`
mutation. Detection strips inherited passwords and tells
missing/open/encrypted/unavailable apart; verify requires encrypted
(an open file's password-ignored warning does not verify).
Workspace mode always binds its absolute `device.cdb`, even when
missing (routes to setup); only no-workspace mode resolves the
operator default, and that mode is the explicit operator-CDB
selection. Lock revokes the token, stops that session's MSP worker,
and drops the context; past chats resume via the session store (T60
seam). Device rows project `(target,user)` only — a temporary
redaction guard pending `tikoci/centrs#551`.

## Set credentials (T48)

Cards without a saved password carry an amber Set credentials
affordance (a subtle Credentials button otherwise; nothing when the
device has no cdb link); the device tab offers the same modal when
stats fail, with the failure as context. The modal shows the
redacted CDB record (target, user, handles, ssh-key path, password
saved or not — never the password) and writes user, password
(no-echo), ssh-key path, profile, and session through `POST
/api/devices/:id/credentials` under the requesting session's unlock:
the browser never sends the unlock password, only the new
credential. Writes re-read before writing and answer 409 with the
redacted current record instead of overwriting drift (the C15
interim stance — a comparison, not a lock); a missing record is
created via `devices add`, never `--force`. The record `--password`
rides argv (centrs offers no env channel for it): never logged, and
transiently ps-visible on this local box only.

## Gaps (unrun on purpose, pending)

- `muse` install attempt, trilogy align-install, auth walkthrough,
  interactive consent prompt, and launch exec: orca already has muse
  authed and pins matching, and runs here are non-TTY. Steps are
  wired; each needs a clean/declined/interactive machine to observe.
- macOS/Windows paths: encoded (installer lines, `where` detects),
  run only on Linux so far.
- Global self-install: still deferred (no `--install-global` yet).
- No telemetry, no updates.
