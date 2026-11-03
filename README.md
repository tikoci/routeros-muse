# routeros-muse

A RouterOS network workspace plus web UI that puts an agent beside
your network. You keep your network's docs, devices, and history in
one workspace folder; routeros-muse checks the machine, grounds the
agent on your real routers, and gives you a browser UI to chat with
it, watch it work, and view what it renders.

Built on the tikoci trilogy: [quickchr](https://github.com/tikoci/quickchr)
(disposable CHR twins), [centrs](https://github.com/tikoci/centrs)
(device access plus credentials), [rosetta](https://github.com/tikoci/rosetta)
(RouterOS knowledge). Started as a hackathon demo; now growing into a
real owner tool.

Status: **preview**. Expect rough edges; nothing here is finished.

## Quick start

Prereqs: [Bun](https://bun.sh) (per Bun's own install instructions),
plus `muse` installed and signed in. Then:

```sh
bunx @tikoci/routeros-muse start   # web UI on 127.0.0.1 by default; opens your browser
```

From a checkout, `bun install` once, then `bun src/index.ts start`
does the same. `start` serves the current directory when it is a
workspace, else walks you through init / pick / browser picker on a
terminal. `make gate` runs the full check (lint + tests + browser
smoke).

Other commands: `init` scaffolds a workspace where you are, `code`
checks the machine then drops you in a `muse` shell in the
workspace, and `doctor` runs the same checks print-only.

## The workspace idea

A workspace is one folder that holds everything about a network:
`workspace.toml` (what this network is), `router.toml` (its devices),
`operations/` and `inbox/` (pending work and handoffs), plus
observations, reports, and history. The agent reads the workspace;
the workspace records what the agent did.

`templates/network/` is the full starter template: conventions,
skills, checks, and layout. New workspaces land in `~/Networks`, one
predictable path on every OS, and serving a workspace registers it
for the no-workspace picker. The web UI's whole-app lock is your CDB
password (see `docs/design/t39-auth-design.md`).

## How it uses the three tools

`package.json` pins `@tikoci/quickchr`, `@tikoci/centrs`, and
`@tikoci/rosetta` (all on `next` during preview). The bootstrap and
the server front the package's own `node_modules/.bin` on PATH for
every spawn — server subprocesses and agent children alike — so all
sides resolve identical builds:

- **quickchr** — twin capability probe (`quickchr doctor`) and
  disposable CHR routers for grounding claims, configs, and scripts.
- **centrs** — LAN discovery (MNDP), device reads and live stats,
  and the CDB credential store (`device.cdb` beside the workspace).
- **rosetta** — RouterOS device database and knowledge lookups for
  the agent, resolved from the same bundle.

## CLI

```sh
routeros-muse [command] [dir] [options]   # bare = start
routeros-muse start [dir] [--port N] [--host H] [--no-open] [--yolo]
routeros-muse init [dir] [--template minimal|network]
routeros-muse code [dir] [muse args...] [--yes] [--router H[:port]] [--print-only]
routeros-muse doctor [dir]
```

`start` (alias: `serve`; bare means `start`): web UI over
the workspace — devices left, chat center, render/status right —
opened in your browser; `--no-open` prints the URL instead.
Defaults: host `127.0.0.1` (`--host` overrides the bind; only do that on
a trusted network), ephemeral port, provider `meta`. When
the directory (default: here) is not a workspace, a terminal offers
init-here / registered-workspace pick / browser picker; off a
terminal the default (here) serves with no workspace attached, while
a named directory that is not a workspace stops with the `init` line. `--yolo` starts the
agent session at its most permissive approval mode (`Allow all`).
The agent worker spawns trusted by default, so the workspace's
AGENTS.md and `.agents/skills/` load (Settings shows the state).
`--tui` aliases `code`. Developer flags: `--no-workspace`,
`--provider NAME`, `--allow-open-cdb` (an open CDB implies no auth),
`--no-trust-workspace` (spawn the agent untrusted: the workspace's
AGENTS.md and skills don't load).

`init`: scaffolds a workspace in the directory (default: here) from
`minimal` (runnable minimum) or `network` (full starter), never
overwriting, and registers it. The web picker's create button
scaffolds into `~/Networks` instead.

`code`: checks prereqs, the trilogy, and the agent; opens and
validates the workspace; reconciles `[pins]`; probes twins and LAN
into a capability mode (`full` / `twin-only` / `real-box-only` /
`design-only`); lists handoffs; then execs `muse` in the workspace
with the package tool bundle on PATH. `--yes` is the one-yes for
echoed user-level installs; `--print-only` prints the launch line
instead of running it; every other arg passes through to `muse`
verbatim and in order (`-c`, `--yolo`, resume flags), with `--`
forcing the rest through. The workspace directory, if you name it,
goes first, before any `muse` arg. Nothing installs without asking.

`doctor`: the same checks print-only. Never installs, never execs
muse. Exit 1 when a required item is missing.

Fleet reads live in `centrs` (`devices list`, `retrieve`), not here;
agents use centrs/quickchr/rosetta directly.

## Docs

- `SECURITY.md` — security facts and known gaps.
- `docs/internals.md` — how the pieces fit (bootstrap steps, server
  routes, render services, unlock, registry, smoke).
- `docs/design/` — design notes carried from the staging archive.
- `docs/concepts/` — UI concept mockups (design references, not product).
- `records/` — the build tracker (needs/tasks/decisions/concepts).
- `templates/network/` — the starter workspace template.
- `tools/` — skill gate, UI smoke, router capture plus checker.
