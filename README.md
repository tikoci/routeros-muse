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
plus `muse` installed and signed in. Then, from a checkout:

```sh
bun install
bun src/index.ts [workspace]        # check the machine, then launch muse in the workspace
bun src/index.ts serve [workspace]  # web UI on loopback; open the printed URL
```

`workspace` is a local folder or a git URL (cloned next to you).
Without one, both commands ask on a terminal. `make gate` runs the
full check (lint + tests + browser smoke).

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
routeros-muse [workspace] [--router H[:port]] [--yes] [--yolo] [--print-only]
routeros-muse serve [workspace] [--port N] [--host H] [--provider NAME] [--no-workspace] [--allow-open-cdb]
routeros-muse devices list [workspace]
routeros-muse devices stats <id> [workspace] [--cdb-file FILE]
```

Bare (Mode A): checks prereqs, the trilogy, and the agent; opens and
validates the workspace; reconciles `[pins]`; probes twins and LAN
into a capability mode (`full` / `twin-only` / `real-box-only` /
`design-only`); lists handoffs; then launches `muse` in the
workspace. `--yes` is the one-yes for echoed user-level installs;
`--yolo` forwards to the `muse` launch only; `--print-only` prints
the launch line instead of running it. Nothing installs without
asking.

`serve` (Mode B): loopback-only web UI over the workspace — devices
left, chat center, render/status right. Defaults: host `127.0.0.1`,
ephemeral port, provider `meta`. `--no-workspace` serves
centrs/quickchr only with a workspace picker; `--allow-open-cdb` is
the dev hatch where an open CDB implies no auth.

`devices`: read-only fleet reads over a workspace (default: the
current directory). `stats` prints live identity plus resource JSON;
an encrypted CDB unlocks via `CENTRS_CDB_PASSWORD` or a no-echo TTY
prompt. Device writes live in the web UI, not here.

## Planned (D35)

The CLI will shrink to an owner surface: `start|serve`, `init`
(scaffold from `minimal|network`), `code` (a `muse` shell with the
bundle PATH plus instructions), and `doctor` (print-only checks).
Agents keep using centrs/quickchr/rosetta directly. Until then, the
reference above is what the code does today.

## Docs

- `docs/internals.md` — how the pieces fit (bootstrap steps, server
  routes, render services, unlock, registry, smoke).
- `docs/design/` — design notes carried from the staging archive.
- `docs/concepts/` — UI concept mockups (design references, not product).
- `records/` — the build tracker (needs/tasks/decisions/concepts).
- `templates/network/` — the starter workspace template.
- `tools/` — skill gate, UI smoke, router capture plus checker.
