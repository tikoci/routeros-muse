# Security policy (first version)

Preview document: concise, factual, and every claim grounded in a
source in this repo (file path or `records/` ID inline). It grows as
we learn. No full independent audit has been done; reviews so far
are per change (the records name them).

## 1. Scope and status

routeros-muse is a local-first RouterOS network workspace plus web UI,
published as a **preview** (0.x: interfaces and defaults may still
change). The threat model is loopback-first: one owner on their own
machine (T63 defers hardening past that).

## 2. Reporting a vulnerability

Report privately through GitHub private vulnerability reporting:
<https://github.com/tikoci/routeros-muse/security/advisories/new>.
Never in a public issue, discussion or pull request.

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
([centrs#586](https://github.com/tikoci/centrs/issues/586), C19; fixed
on centrs main, not yet in the bundled 0.1.9-next.24), not a policy
failure. Anyone who needs "never reboot" needs
the restricted account.

Read-only is not the same as safe to show. A seeded read runs without
an approval, and its output lands in the transcript. If the agent's
RouterOS account has the `sensitive` policy, `centrs retrieve` can
pull PPP secrets, script sources, or Wi-Fi keys into the chat
([centrs#542](https://github.com/tikoci/centrs/issues/542), C1). Give
agent sessions an account without `sensitive`.

The seeded file viewers (D54: `ls`, `cat`, `head`, `grep` and the
others in `READ_COMMANDS`) take any path, so a session can read files
outside the workspace without an approval, as far as the sandbox
allows. Not yet verified: whether muse treats a shell redirect
(`echo x > router.toml`) as a separate write needing approval, or lets
it run under the `echo`/`cat` rule (T153).

## 4. Access modes and permission profiles

Two modes in the UI and `--yolo` flag (D38, D42,
`src/serve/server.ts` `profileForAccess`):

- **Ask first** (default): approval mode `promptUnmatched` under
  permission profile `:ask-me` — bubblewrap sandbox (writable roots:
  workspace, `/tmp`, `$TMPDIR`), a network-kind approval per
  destination, human review.
- **Allow all** (`--yolo`): `allowAll` under `:unrestricted` — no
  sandbox, full egress, no reviewer.

Settings → **Disable sandbox** (T171, partial T156) is a separate,
machine-wide web UI opt-in, default off. It passes `--disable-sandbox`
at worker startup without changing approval mode or permission profile.
Ask first retains command approvals, but filesystem confinement and
network isolation are removed, including destination restrictions from
seeded host rules. Approved commands can write outside the workspace.
Allow all is already unsandboxed regardless of this switch. The setting
is latched at server startup: changing it requires stopping and starting
routeros-muse; page reloads, new chats and worker replacement alone do not
apply it. Settings reports saved versus running state.

The legacy modes the access route still accepts (`onRequest`,
`denyUnmatched`) map to `:ask-me`, subject to the same startup override.
The machine's `settings.json` default profile is never edited.

## 5. Where trust, rules, and settings live

Each workspace gets its own **private muse config home** (D44, D45,
`src/lib/preallow.ts`):

`<dataHome>/routeros-muse/.muse-config/<workspace-id>/`

holding its own `muse/approval-policy.json` (schema v2), minimal
`muse/settings.json`, an `auth.json` symlink to the real
`$XDG_CONFIG_HOME/muse/auth.json`, and a `tikoci` config symlink.
The shared `~/.config/muse` is never written. No-workspace mode gets
the fixed `_no-workspace` home with MCP tool rules and packaged skills,
but no workspace shell or host rules. Every rule we
write carries `reason: "routeros-muse:seed"`; untagged rules (the
owner's own Always-allow choices) are never touched. Fail-closed: a
symlink at or below `<dataHome>/routeros-muse` skips seeding and no
worker spawns with that home.

GUI workers load the package-pinned RouterOS skills from their private
`muse/skills/` directory by default, regardless of workspace trust
(T100, `src/lib/routeros-skills.ts`). Only skill directories and their
references are copied, never the upstream repository's hooks. The
machine-wide Settings switch takes effect at the next new or resumed
chat. A hash manifest owns copied files; unowned files and local edits
are preserved with warnings, and symlinks in the affected private tree
are refused. This switch does not remove independently installed or
workspace skills. The managed private copies take precedence over
same-name personal copies; trusted workspace copies can take
precedence over the bundle, reported in Settings. Loading a skill
grants no router permissions and does not change the session's profile.

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
- Network allow rules for this workspace's own device hosts only: the
  targets in its `device.cdb` (refreshed on every good device list,
  T148) plus any `router.toml` hosts; no cross-workspace union.
- `tool_action` rules for the four `ui_*` MCP tools (`ui_notify`,
  `ui_open`, `ui_select_device`, `ui_add_device`).
- `tool_action` rules for rosetta's local-read MCP tools (T105,
  `src/mcp/trilogy-tools.ts` `ROSETTA_SEED_TOOLS`);
  `routeros_current_versions` stays unseeded (per-call fetch to the
  upgrade server). Mixed or write tools are never seeded.

Agent sessions reach centrs through its CLI; rosetta stays as MCP
(D46; T112 removed centrs MCP and its seeded `centrs_*` read rules
from the session config, and stale tagged `centrs_*` rules prune on
reseed; T105 had shipped both). The `quickchr list`/`doctor` housekeeping (stale
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
- Passwords never go in session config, transcripts, or logs: while
  centrs MCP shipped (T105, until T112) it got only `CENTRS_CDB_FILE`
  in config env, never the password (T111); the UI
  redacts records to `(target, user)` as defense-in-depth (T64;
  upstream `tikoci/centrs#551`, withholding passwords by default,
  shipped in centrs 0.1.9); typed secrets never echo (T72).

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
- T98: `/api/file` reads/writes and `/api/toml` now deny credential
  names (`*.cdb` and backups) on every path component. Reads use an
  lstat walk, `O_NOFOLLOW|O_NONBLOCK`, fstat and a bounded fd read
  (512 KiB). Read-only symlink targets must stay inside the workspace
  and pass the same credential checks, preserving `observations/*/latest`.
  Writes refuse all symlinks and write through a regular-file fd;
  new files are created exclusively. Accepted residual: a concurrent
  parent-directory swap during the walk/open window (Node has no
  openat), as for T83/T97. The pane fetch enforces its own checks
  independently of `ui_open` preflight.
- T111: no password channel into centrs MCP for encrypted CDBs
  (calls fail honestly with `cdb/password-required`) — deferred by
  D46: centrs MCP leaves the session config this phase (T112) and
  returns after GitHub; upstream half tracked in
  [centrs#602](https://github.com/tikoci/centrs/issues/602).
- T47: RO/RW access level not yet shown on device cards — open.
- T82/C15 ([centrs#581](https://github.com/tikoci/centrs/issues/581)):
  stale-secret protection is an interim modal note until the
  upstream secret-safe revision contract lands.
- C19 ([centrs#586](https://github.com/tikoci/centrs/issues/586)):
  fragment-path non-read dispatch — fixed on centrs main, awaiting a
  centrs publish and our bump; until then the bundled build still
  has it. See §3.
- C1 ([centrs#542](https://github.com/tikoci/centrs/issues/542)):
  secret-bearing values reach the transcript through seeded reads
  when the account has the `sensitive` policy. Mitigation is the
  account, see §3.
- D48 (open): if centrs MCP returns as an option, it is gated on a
  password channel that keeps the secret off the MSP wire (C20,
  [centrs#603](https://github.com/tikoci/centrs/issues/603)), failed
  calls marked `isError` (C22,
  [centrs#605](https://github.com/tikoci/centrs/issues/605)), and
  `centrs_devices` refusing record passwords as tool arguments
  ([centrs#582](https://github.com/tikoci/centrs/issues/582)).
