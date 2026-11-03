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
grant); the server spawns it with `--trust-workspace` by default
(D39; `start --no-trust-workspace` opts out, no-workspace mode never
passes it — no workspace to trust), `/api/status` reports
`trustWorkspace` (true/false/null), and the Settings pane shows it.
`src/serve/server.ts` bridges chat (send/history/SSE stream;
tree, recents, files (TOML validate-before-save), devices (router.toml
devices; live stats need a bound host), twins, alerts, and past chats;
chat send carries the composer's device pills as validated targets
(ids checked against router.toml — the CDB in no-workspace mode —
with one `[routeros-muse context]` line per known device prepended
to the turn text, stripped back out of history; the UI shows chips
on the sent bubble, never the raw preamble);
history carries structured transcript rows (toolCall/subagent cards
with raw-text fallback) and live SSE rows ride the same mapper, with
tool output/diff bodies openable in middle tabs via item/readOutput
(T37); `src/serve/ui.html` is the v10 concept live-wired (no demo
content). Providers: `meta` default, `echo` for hermetic tests. Brand
row carries the production MikroTik symbol + Meta mark (T35). T40
split the UI-agnostic reads out of the server into
`src/lib/workspace.ts` (tree/recents/files/alerts/artifacts) and
`src/lib/fleet.ts` (devices/stats/twins); the routes are thin
wrappers over those modules. `GET /api/artifact` serves any
workspace path with a renderable extension (T83: html/htm/svg/
png/jpg/jpeg/gif/webp, 8 MiB cap) behind the same auth as the
other `/api` routes, with per-tier sandbox CSP + nosniff +
no-store; the tree annotates each artifact with a tier hint
(the serve tier is decided from the bytes, the viewer label
from a fresh meta fetch). No symlink anywhere in the path:
lstat walk, `O_NOFOLLOW` open, fstat + fd-read so one opened
object is checked and served;
a swapped dir component mid-request is an accepted residual,
same class as the T97 preflight-vs-write window.

Render services (T33 done, T83 viewer): `src/render/jobs.ts` runs
named jobs into `<workspace>/reports/render/<job>-<stamp>/` with
source + time + sandbox tier (`job.json`: topology scripts, report
static) plus an HMAC provenance signature (`job.json.sig` over
tier + sha256 of every artifact member the job signed, keyed
from `<dataHome>/routeros-muse/render.key`). Topology splits
by context
per D21 (web: mermaid .mmd + HTML with the pinned mermaid bundle
inlined, fully offline; CLI: DOT + `dot -Tsvg`, text fallback);
report renders markdown to self-contained HTML. Map/chart have
defined contracts and honest not-built errors. Served via
`POST /api/render` + `GET /api/artifact`; the UI opens artifacts
framed in a middle tab (T83, D17/D19): static by default, scripts
only for verified render-job tiers (a forged `job.json`, a flipped
tier, or edited outputs fail closed to static, unlabeled) or the
owner's Run scripts toggle — scripts are the owner's opt-in. The
provenance defends against forged/edited workspace metadata, not a
same-user shell reading the key. Fetches and subresources are
blocked by the opaque-origin CSP, but navigation is NOT blockable
by browser policy (Chromium has no `navigate-to`): the UI counts
the frame's loads and blanks a navigating artifact with an inline
notice instead. Artifacts must be self-contained. Residual: an
artifact that navigates before its own load completes can escape
the load counter — the first request out can't be prevented
either, only reacted to.

## Managed RouterOS skills (T100)

`routeros-skills` is a production GitHub dependency pinned to a full
commit in package.json and bun.lock. `src/lib/routeros-skills.ts`
resolves it relative to the installed package, including hoisted
dependencies, and stages its skill directories and references into
`<private-config-home>/muse/skills/`. This runs at boot and before a
new/resumed GUI chat, including the fixed no-workspace home, without
requiring workspace trust or network access. The CLI `code` path
continues to use the operator's normal Muse config.

`<dataHome>/routeros-muse/settings.toml` stores one default-true
`[agent] auto_routeros_skills` boolean. `/api/settings` reads/saves it;
saving never changes the live chat's files. Settings reports the saved
preference, the applied value, pending changes, and delivery or catalog
warnings. A response sequence prevents delayed status reads from
overwriting a newer preference/catalog result in the browser.

`muse/routeros-muse-skills.json` records source/revision and per-file
SHA-256 ownership. Reconciliation updates/removes unchanged owned
files only, preserves local edits and unrelated files, and refuses
symlink/special-file chains. An exclusive PID lock prevents concurrent
delivery into one private home; dead owners can be recovered. New
files are created exclusively, replacements and the manifest use
fully written sibling files. Like init, this assumes no adversarial
parent-directory swaps. An interrupted delivery can leave unrecorded
files; those are treated as unowned and reported instead of adopted.

After session start/resume, MSP `skill/list` and `muse skills list
--json` under the same private config/data homes verify the invocable
subset, full catalog paths and diagnostics. Same-name personal copies
shadowed by the bundle are a separate notice; workspace overrides and
missing/broken skills are surfaced. A catalog-check failure reports
verification unavailable; a delivery failure refuses the worker/new
chat while keeping Settings available for recovery.

T119 holds workspace overrides. T120 holds template/package refresh
and drift tooling; neither is part of the current settings path.

## Templates (T93)

`templates/<name>/` is the single init source: `template.toml`
(name, description, version — never copied) plus the files to copy.
The scaffold copies recursively, substitutes `{{name}}` in
`*.toml`/`*.md`, stamps a `[template]` provenance table into the new
`workspace.toml` (a record, never enforced), then runs `centrs
devices init`. `minimal` is the runnable minimum the UI populates
from; `network` is the full starter. Both scaffold and pass
workspace validation; templates resolve via the package root so
bunx/npm installs find them. The network template's 55 skills live
at `.agents/skills/<name>/SKILL.md` (D40) — the path muse loads
project skills from under trust — and the scaffold copies
dot-directories, so init lands them there; `bun
tools/check-skills.ts` gates their shape against that root. The picker create flow and `init`
share this path (`scaffoldWorkspace` for create-at-default,
`scaffoldIntoDir` for init-in-place with its never-overwrite
conflict list). Init assumes no concurrent adversary in the
destination tree: exclusive creates plus ownership-checked
rollback defeat pre-existing files, accidental races, and partial
failure, but a mid-copy parent swap is accepted (Node has no
openat).

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
the diff renderer, the lock/unlock/bypass/missing auth legs,
the no-workspace picker (list/open/prune/create), and the T83
artifact viewer (offline topology render, tier toggle, svg/png,
static report); screenshots land
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

## Add device (T110)

The same credentials modal in add mode: the agent calls the
`ui_add_device` MCP tool (host required, user/id optional —
validated like the route, `ok:true` means the dialog opened, never
that the device was added), the server emits `ui/add-device`, and
the UI opens the modal titled `Add device · <host>` with the user
prefilled, the host display-only (never an editable field), and a
context line stating the save adds the `[device]` block to
`router.toml` (workspace mode) plus creates the CDB record. The
owner types the password there; the modal POSTs `POST
/api/devices/add`, which re-validates, appends the block
(idempotent on same id+host+cdb, 409 when the id or host belongs
elsewhere, refuses on unparseable `router.toml` without writing),
then creates the record through the T48 `{missing:true}` path —
retrying under its own snapshot only when the existing record
carries the same user, never overwriting a stranger's
credentials. A CDB failure leaves the `router.toml` entry in
place (the card's Set credentials is the recovery) and answers
`ok:false` with the stage and device id. No-workspace mode skips
`router.toml` and creates the CDB record only. On success the
modal clears its fields first, closes, reloads the device list,
and renders the new card. Encrypted-CDB creation may fail until
upstream `tikoci/centrs#558` — surfaced, not worked around.

## Gaps (unrun on purpose, pending)

- `muse` install attempt, trilogy align-install, auth walkthrough,
  interactive consent prompt, and launch exec: orca already has muse
  authed and pins matching, and runs here are non-TTY. Steps are
  wired; each needs a clean/declined/interactive machine to observe.
- macOS/Windows paths: encoded (installer lines, `where` detects),
  run only on Linux so far.
- Global self-install: still deferred (no `--install-global` yet).
- No telemetry, no updates.
