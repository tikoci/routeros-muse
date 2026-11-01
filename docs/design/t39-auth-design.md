# T39 auth design (spike-refined, 2026-11-01)

Target: D24 whole-app gate. CDB-password web login + Meta-OAuth-gated chat.

## Spike results (verified against real binaries, no memory)

CDB (centrs 0.1.9-next; source `~/Projects/tikoci/centrs`, envelope codes
in `src/devices.ts` + `src/core/error-catalog.ts`, probed live on /tmp CDBs):
- `devices list --cdb-file X --format json` is the whole auth protocol:
  open CDB, no password → ok:true (state = open).
- Encrypted, no password → ok:false `cdb/password-required`.
- Encrypted, wrong password → ok:false `cdb/decrypt-failed`.
- Open + password → ok:true with `cdb/password-not-needed` warning
  (password ignored — so check state BEFORE checking passwords).
- Error envelopes exit 1; success exits 0.
- NO CLI path encrypts an open CDB: init creates open, writes to open
  stay open (`encryptWithFor` returns undefined for open), only WinBox
  encrypts. D24's "force encryption via centrs" is blocked on C14
  (upstream tikoci/centrs#558, open; our T39 consumer case commented
  there 2026-11-01). Until then the open-CDB guidance says WinBox.
- Fixture: `tests/fixtures/cdb-encrypted-empty.cdb` (0 records, password
  `t39-fixture-password`), generated once via centrs@0b3f589
  `writeWinBoxCdb([], {encryptWith})`; all three CLI paths verified.

OAuth (muse 1.4.14, MSP schema exported from the binary):
- No status method exists (70 methods; nearest is `usage/read`, which
  returns `{}` logged-in AND logged-out — useless as a gate).
- `model/list`, `session/list`, `initialize` all succeed logged-out.
  `session/start` succeeds logged-out. Only a TURN discriminates.
- Logged-out turn: `turn/start` accepted, `turn/completed` in ~300ms
  with `terminal=failed` + `error.kind=authRequired`,
  message "not logged in: run /login to add an API key".
- Logged-in control turn: terminal=completed in ~6s ("ok").
  (Also closes the owed meta-provider demo thread as a side effect.)
- Auth lives in `~/.config/muse/auth.json` — XDG_DATA_HOME isolation
  does NOT remove it. Hermetic logged-out tests must isolate
  XDG_CONFIG_HOME too (new `museConfigHome` spawn opt; real server
  never sets it).
- `muse login` is terminal-interactive, so the web affordance is
  instructions + Recheck, never an in-page flow.

## Decisions

- Bypass flag: `--allow-open-cdb` (serve CLI + `ServeOpts.allowOpenCdb`).
  Open CDB without it → guidance screen, no entry. With it → entry plus
  an honest bypassed indicator.
- Auth states: `locked` (encrypted, no session), `unlocked`,
  `open-needs-encryption` (open CDB, no flag), `bypassed` (open + flag).
- Which CDB: workspace `device.cdb` in workspace mode, resolved default
  CDB in no-workspace mode, `opts.cdbFile` beats both (tests).
- Session: 128-bit random token, in-memory map, `rmsid` HttpOnly
  SameSite=Lax cookie (no Secure: http LAN; noted in T63). Restart =
  re-login. Wrong password: 500ms fixed delay, 401 + code.
- Gate: `/` always serves the shell; shell boots from
  `GET /api/auth/state` and renders lock/guidance overlays instead of
  the app when not admitted. Every `/api/*` except `/api/auth/*`
  answers 401 without a valid cookie (SSE included — EventSource
  carries cookies).
- OAuth states: `unknown` | `authed` | `absent`. Echo provider starts
  authed (no OAuth concept). Meta: background disposable probe at boot
  (session/start + "Reply with only the word ok" turn + leave); ONLY
  `authRequired` flips to absent — other failures stay unknown, never
  disable. Any main-session turn completing with `authRequired` flips
  passively. Absent → composer disabled + banner ("run `muse login` in
  your terminal") + Recheck (`POST /api/auth/oauth-recheck`).
- `TurnOutcome` gains the completion `error` (additive) so both probe
  and passive flip read `error.kind`.
- UI honesty: new live `Auth` row in Settings (locked/unlocked/
  bypassed/open-needs-encryption); bypass never silent.
- T40 seam: steering "toward creating a workspace at the default
  location" needs the T40 registry; T39 shows the encrypt guidance for
  the CDB at hand and notes the creation flow lands with T40.

## Test plan

- Suite: unlock ok/wrong/open/absent via temp workspaces + vendored
  fixture; cookie gating 401/200; bypass-flag behavior; probe logic via
  stubbed client (authRequired→absent, completed→authed, other→unknown);
  hermetic logged-out probe via config-home isolation (fast-fail, no
  turn cost). No live meta turns in `bun test`.
- Smoke: encrypted-fixture workspace boots to lock screen; wrong
  password errors; right password boots app + chat roundtrip; second
  boot with open CDB + flag enters bypassed.
