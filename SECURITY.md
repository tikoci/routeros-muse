# Security policy (first version)

Preview document: concise, factual, and every claim grounded in a
source in this repo (file path or `records/` ID inline). It grows as
we learn. A full audit happens before GitHub (D34).

## 1. Scope and status

routeros-muse is a local-first RouterOS network workspace plus web UI,
currently in **preview** and **not yet published** (D34: public
GitHub waits for a final local sweep plus real test turns, on the
developer's trigger). The threat model is loopback-first: one owner on
their own machine (T63 defers hardening past that).

## 2. Reporting a vulnerability

Until the repo is public, report privately to the maintainer; GitHub
private advisories once published.

## 3. The boundary statement

routeros-muse is **not** a policy enforcer for the router. The
RouterOS account the agent uses **is** the security boundary. centrs
is a helper: it validates commands and splits reads from writes
(`--yes` gates writes). But RouterOS reveals RO/RW/policy only at run
time, so strict setups (for example "never reboot") should give agent
sessions a restricted RouterOS account. (T102, C19.)

This is load-bearing, not boilerplate: a seeded `centrs retrieve`
rule trusts centrs's read/write split, and the fragment-path bug that
rebooted a disposable CHR without `--yes` is an upstream bug
([centrs#586](https://github.com/tikoci/centrs/issues/586), C19, still
open), not a policy failure. Anyone who needs "never reboot" needs
the restricted account.

## 4. Access modes and permission profiles

Two modes in the UI and `--yolo` flag (D38, D42,
`src/serve/server.ts` `profileForAccess`):

- **Ask first** (default): approval mode `promptUnmatched` under
  permission profile `:ask-me` — bubblewrap sandbox (writable roots:
  workspace, `/tmp`, `$TMPDIR`), a network-kind approval per
  destination, human review.
- **Allow all** (`--yolo`): `allowAll` under `:unrestricted` — no
  sandbox, full egress, no reviewer.

The legacy modes the access route still accepts (`onRequest`,
`denyUnmatched`) map to the sandboxed profile: only an explicit Allow
all lifts the sandbox. The machine's `settings.json` default profile
is never edited.

## 5. Where trust, rules, and settings live

Each workspace gets its own **private muse config home** (D44, D45,
`src/lib/preallow.ts`):

`<dataHome>/routeros-muse/.muse-config/<workspace-id>/`

holding its own `muse/approval-policy.json` (schema v2), minimal
`muse/settings.json`, an `auth.json` symlink to the real
`$XDG_CONFIG_HOME/muse/auth.json`, and a `tikoci` config symlink.
The shared `~/.config/muse` is never written. No-workspace mode gets
the fixed `_no-workspace` home with nothing seeded. Every rule we
write carries `reason: "routeros-muse:seed"`; untagged rules (the
owner's own Always-allow choices) are never touched. Fail-closed: a
symlink at or below `<dataHome>/routeros-muse` skips seeding and no
worker spawns with that home.

`--trust-workspace` (passed by default, D39; `--no-trust-workspace`
opts out) enables workspace skills (`.agents/skills/`), rules
(`AGENTS.md` walk-up), and hooks (`.muse/hooks.json`). Note the
residuals, all grounded in `docs/design/permissions.md` (P8): hooks
run **outside** sandbox and approvals with a cleared env (doc-backed,
not live-probed); the project memory index loads even untrusted; MCP
servers run as unsandboxed processes; `trust.json` is TUI memory that
serve ignores.

## 6. Pre-allowed reads

Under the Settings toggle, each workspace's policy seeds (T101,
`src/lib/preallow.ts` `READ_COMMANDS`):

- `centrs retrieve`, `quickchr list`, `quickchr doctor` — two-word
  argv prefixes scoped to the workspace's absolute root (`centrs
  execute` stays unlisted: `--yes` cannot be excluded).
- Network allow rules for this workspace's `router.toml` device hosts
  only (no cross-workspace union).
- `tool_action` rules for the four `ui_*` MCP tools (`ui_notify`,
  `ui_open`, `ui_select_device`, `ui_add_device`).

Agent sessions reach centrs through its CLI; rosetta stays as MCP
(T112, in progress — removes centrs MCP from the session config; T105
had shipped both). The `quickchr list`/`doctor` housekeeping (stale
local PID/marker cleanup under `~/.config/quickchr`, no device
contact) is accepted in the read set.

## 7. Credentials and the CDB

Encryption comes from centrs; the CDB password is the web UI's
whole-app lock (T39, T64, `docs/internals.md` Unlock):

- `/api/auth/unlock` binds `{cdbFile, password}` to the session
  token. The password travels only into child envs (`CENTRS_CDB_FILE`
  plus `CENTRS_CDB_PASSWORD` via one explicit per-worker
  environment) — never ambient globals, never `process.env` mutation.
  Detection strips inherited passwords.
- **Lock is worker-stop, not revocation**: it revokes the token,
  stops that session's MSP worker, and drops the context (T64, T81).
  Never imply credentials were revoked from an already-running child.
- Passwords never go in session config, transcripts, or logs: centrs
  MCP gets only `CENTRS_CDB_FILE` in config env (T111); the UI
  redacts records to `(target, user)` as a temporary guard pending
  upstream `tikoci/centrs#551` (T64); typed secrets never echo (T72).

Privacy tiers (D1): low-sensitivity (models, MACs, private IPs,
software keys) may travel; high-sensitivity (credentials, tokens,
serials, public IPs, people, locations) never does. Captures (`out/`)
stay local, never committed.

## 8. Web UI auth and its limits

First pass (T39, `docs/design/t39-auth-design.md`,
`src/serve/server.ts`, `src/serve/auth.ts`): whole-app CDB gate with
a 128-bit random token in an in-memory map, `rmsid` HttpOnly
SameSite=Lax cookie (**no Secure**: http LAN), restart means
re-login, wrong password gets a 500 ms fixed delay plus 401, chat is
OAuth-gated (auth probe, banner plus Recheck, 403 on send). An open
CDB implies no auth only behind the explicit `--allow-open-cdb` flag.
Stated limits (T63, open): no rate limiting beyond the fixed delay,
no Secure cookie, in-memory sessions. The server binds **127.0.0.1**
by default (`opts.host ?? "127.0.0.1"`); `--host` overrides the bind
with no other network restriction. The `ui_*` relay rides its own
127.0.0.1 ephemeral listener (T106), loopback only.

## 9. Artifact sandbox and init write safety

Artifacts (T83): `GET /api/artifact` serves renderable workspace
paths behind the same auth, with per-tier sandbox CSP plus nosniff
plus no-store, fd-safe resolution (lstat walk, `O_NOFOLLOW` open,
fstat plus fd-read), and HMAC provenance for render-job script tiers
(keyed from `<dataHome>/routeros-muse/render.key`). Accepted
residuals: an immediate navigation escapes detection and its first
request leaves; dir-swap race mid-request.

Init (T97): exclusive non-following creates, each write recorded as
it lands, rollback removes only what the run created. Accepted: a
mid-copy parent swap (Node has no openat).

## 10. Known gaps

- T63: auth hardening (rate limiting, Secure cookie, durable
  sessions) — deferred past the loopback-first model.
- T98: `/api/file` still resolves by pathname (symlink follow,
  no `device.cdb` denial, `ui_open` swap window) — open.
- T111: no password channel into centrs MCP for encrypted CDBs
  (calls fail honestly with `cdb/password-required`) — open,
  developer decision pending.
- T47: RO/RW access level not yet shown on device cards — open.
- T82/C15 ([centrs#581](https://github.com/tikoci/centrs/issues/581)):
  stale-secret protection is an interim modal note until the
  upstream secret-safe revision contract lands.
- C19 ([centrs#586](https://github.com/tikoci/centrs/issues/586)):
  fragment-path non-read dispatch — open upstream; see §3.
