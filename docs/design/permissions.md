# muse permission + approval scheme — live `meta` captures (2026-11-02)

Research for the permissions explorer (D38 option C: pre-allow our
designed read set under promptUnmatched) and seed for a future
SECURITY.md. Every behavioral claim comes from a wire capture, a file
the run produced, or binary-exported schema — never memory. Public
docs ([permissions](https://dev.meta.ai/docs/muse-code/permissions.md),
[extending](https://dev.meta.ai/docs/muse-code/extending.md),
[configuration](https://dev.meta.ai/docs/muse-code/configuration.md))
are cited only where a live probe confirmed or bounded them.

- `muse --version`: `Muse Code 1.4.14 (1.4.14-R7309.1)`
- Capture dir (main checkout, gitignored, never committed):
  `out/wire-capture/perm-20261102T000756Z/`
- Capture tool (committed): `tools/msp-capture.ts` — Bun, zero deps.
  Extended for this campaign: `--experimental` (experimentalApi opt-in),
  `--permission-profile`, `--approve=persist|choice:<id>`, and a `raw`
  subcommand (initialize + session/start + scripted method calls with
  `$S`/`$C` substitution, `--settle-ms`).
- Provider: real `meta`. Isolation: temp `XDG_DATA_HOME` per probe
  (`/dev/shm/perm-20261102T000756Z/muse-home-*`); `XDG_CONFIG_HOME`
  left at default except where noted (P2 found relocation limits).
- Workspaces: temp dirs under `/dev/shm/perm-20261102T000756Z/`
  (`ws-min`, `ws-net`, `ws-p2`, `ws-p3` from
  `bun src/index.ts init <dir> --template minimal|network`),
  plus `~/ws-p6home` and `~/ws-trustprobe` where noted.
- `$TMPD` below = `/dev/shm/perm-20261102T000756Z`,
  `$CAPDIR` = `out/wire-capture/perm-20261102T000756Z/`.
- Listener (P6): throwaway `bun $TMPD/listener.ts` on 0.0.0.0:3000,
  killed after; log saved as `listener.log` (8 HITs, all expected).

## P1. Rule persistence

**Answer: "Always allow in this workspace" writes
`$XDG_CONFIG_HOME/muse/approval-policy.json` (`schema_version: 2`) —
not the workspace, not the muse data home. Rules are scoped to an
absolute `workspace_root`, survive new sessions and serve restarts,
and are removed by editing the file (no wire method exists).**

Command (persist `ls` for `ws-min`):

```sh
bun tools/msp-capture.ts turn --provider meta \
  --workspace $TMPD/ws-min --muse-home $TMPD/muse-home-p1 \
  --approval-mode=promptUnmatched --approve=persist \
  --out $CAPDIR/10-p1-ls-persist.jsonl \
  --prompt="Run the command 'ls' in the workspace and report the filenames. Do not access the network."
```

Excerpt (`10-p1-ls-persist.jsonl`, `approval/resolved`):

```json
{"decision":"approvedPolicyAmendment","policyResult":"allow","resolvedBy":"user",
 "amendment":{"durability":"localPersistent","rulePreview":"Always allow in this workspace: ls ..."},
 "stageEvidence":[{"argv":["ls"],"resolution":{"argvPrefix":["ls"],"kind":"policyAmendment"}}]}
```

File created by that decision (birth mtime = decision second;
saved copy `p1-policy-file.json`):

```json
{"schema_version":2,"rules":[
 {"effect":"allow","durability":"local_persistent",
  "rule":{"kind":"shell_command_argv_prefix","argv_prefix":["ls"],
          "workspace_root":"/dev/shm/perm-20261102T000756Z/ws-min"},
  "reason":null}]}
```

Survival (`11-p1-ls-again.jsonl`: fresh data home, new serve
process, same config home, `--approve=never`): `ls` ran with
`approvalId: null`, zero `approval/*` frames, turn completed.
Workspace scoping (`13-p1-ls-otherws.jsonl`: same rule, `ws-net`):
`SR:approval/request` fired. Removal (rule deleted from the JSON,
`12-p1-ls-after-remove.jsonl`, `ws-min`): approval fired again.
The workspace gained no files in any P1 run (`find -newer` clean).

Rule-removal surface: the stable and experimental schemas expose no
policy/rule write or delete method (`settings/writeValue` admits
only string|boolean|null values — it cannot express a rule edit),
so removal is a file edit (or the TUI, untested here).

## P2. Pre-seeding

**Answer: two working paths — (a) select a profile at
`session/start`, (b) pre-write the P1 rule file. End-to-end proof
below is path (b): seeded `ls`+`cat` ran unprompted while `rm`
still prompted.**

### Profiles: what exists, how defined

`permissionProfile/list` (experimental; `01-profiles.jsonl`) serves
4 native rows; `session/start` accepts `permissionProfile` as a
**stable** member ("select, never create"):

| profileId | label | reviewer | axes (approval/filesystem/network) |
|---|---|---|---|
| `:read-only` | Read only | human | onRequest / sandboxed / restricted |
| `:ask-me` | Ask me | human | onRequest / sandboxed / off |
| `:auto-review` | Auto-review | autoReview | onRequest / sandboxed / off |
| `:unrestricted` | Unrestricted | none | allowAll / unrestricted / enabled |

(Axes from `02-p2-profile-{ask-me,read-only,auto-review}.jsonl` +
`01-profiles.jsonl`, `session/start` → `session.permissionState`.)
Unknown ids are refused before any durable byte
(`03-p2-profile-unknown.jsonl`):
`commandRejected (-32030): no profile :nope in the host catalog`.
The default comes from `settings.json`
(`07-p2-default-profile.jsonl`: isolated settings with
`permissions.default_profile: ":ask-me"` → start without the member
yields `profileId: ":ask-me"`, sandboxed/off axes). This machine's
file sets `:unrestricted`, which is why serve sessions here default
to reviewer `none`. User/managed profile *definitions* exist only
via enterprise policy planes (`muse config validate
--plane <defaults|policy>`; binary strings
`execution.permission_profiles.{allowed,fallback}`) — no live test.

### Path (b): pre-write the rule file, end to end

Config `~/cfgtest-perm` (copies of auth/settings/trust + seeded
`approval-policy.json` with `[ls]` and `[cat]` prefixes for `ws-p2`):

```sh
XDG_CONFIG_HOME=/home/amm0bot/cfgtest-perm bun tools/msp-capture.ts turn \
  --provider meta --workspace $TMPD/ws-p2 --muse-home $TMPD/muse-home-p2c \
  --approval-mode=promptUnmatched --approve=never \
  --out $CAPDIR/20-p2-seeded-ls-cat.jsonl \
  --prompt="Run the command 'ls' in the workspace and then run 'cat workspace.toml'. ..."
```

Excerpt (`20-p2-seeded-ls-cat.jsonl`): two `bash` toolCalls,
`approvalId: null`, no approval frames. Contrast
(`21-p2-rm-prompts.jsonl`, same config, `rm --version`):
`SR:approval/request` fired (allow_once/allow_local_prefix/abort),
approved once, `rm (GNU coreutils) 9.12` reported.

### Config-home relocation boundary (anomaly, grounded)

`muse serve` honors `XDG_CONFIG_HOME` for settings
(`05-p2-xdg-test.jsonl`: isolated `provider: echo` served back) but
**meta auth fails off `$HOME`**: `XDG_CONFIG_HOME=$TMPD/cfg-p2`
(byte-identical `auth.json`, modes preserved) →
`turn/completed terminal=failed error={"kind":"authRequired",
"message":"not logged in: run /login to add an API key"}`
(`22-p2-xdg-shm-authfail.jsonl`, twice), while the real home works
(`06-authchk.jsonl`, PONG) and an under-`$HOME` copy works (`20`).
Boundary observed: `/dev/shm` fails, `$HOME` works. Mechanism
undetermined (binary strings: `credential_backend`,
`keychain_fallback_reason`). Practical rule: keep test config homes
at default or under `$HOME`.

## P3. Granularity

**Answer: prefix rules match leading argv words (trailing args free),
so `centrs retrieve` is allowlistable without `centrs execute` —
both directions verified. Pipelines and `&&` split into separately
resolved stages under one approval; `sh -c`/`bash -c` unwrap to the
inner argv (no smuggling, no fail-open). Nothing expresses "prompt
when `--yes` is present". Interpreter prefixes are never persistable.**

Setup: stub `centrs` (echoes argv, exit 0) on PATH; config
`~/cfgtest-p3` seeds `[centrs, retrieve]` for `ws-p3`, `~/cfgtest-p3b`
seeds `[centrs, execute]` (`30-p3-prefix-matrix.jsonl`):

| command | rule | result |
|---|---|---|
| `centrs retrieve --help` | `[centrs retrieve]` | NO prompt |
| `centrs execute --help` | `[centrs retrieve]` | PROMPT (suggests `[centrs execute]`) |
| `centrs retrieve --help \| cat` | `[centrs retrieve]` | PROMPT; retrieve stage `policyAllow`, `cat` stage `allowOnce` |
| `centrs retrieve --help && centrs execute --help` | same | PROMPT; per-stage split as above |
| `sh -c 'centrs retrieve --help'` | same | NO prompt (unwrapped, matched) |
| `sh -c 'centrs execute --help'` | same | PROMPT, stage argv `[centrs execute --help]` (`31-p3-shwrap.jsonl`; identical for `bash -c`) |
| `centrs execute --help --yes` | `[centrs execute]` | NO prompt — `--yes` swallowed (`32-p3-yes-flag.jsonl`) |
| `centrs retrieve --help` | `[centrs execute]` | PROMPT (never answered → abort → turn cancelled) |
| `python3 --version` | — | PROMPT with choices `allow_once` + `abort` only: no `allow_local_prefix` (`33-p3-interp.jsonl`) |

Excerpt (`30`, `approval/resolved` for the `&&` case — one approval,
per-stage evidence):

```json
{"decision":"approved","policyResult":"allow",
 "stageEvidence":[
  {"argv":["centrs","retrieve","--help"],"resolution":{"diagnostic":"local_persistent:argv_prefix","kind":"policyAllow"}},
  {"argv":["centrs","execute","--help"],"resolution":{"kind":"allowOnce"}}]}
```

Rule kinds seen (file + binary `ReviewMatcherKind`): only
`shell_command_argv_prefix`, `shell_command_exact_raw`,
`tool_action`, `filesystem`, `network` — all positive matches, no
flag conditions, no deny observed on the wire (docs say a deny rule
overrides allow; not live-tested).

## P4. denyUnmatched

**Answer: pre-allowed commands run; unmatched commands still emit a
full `approval/request`, which policy auto-denies within the same
millisecond (`resolvedBy: policy`). The agent retried and finished
the turn itself — nothing pends.**

- Allowed (`40-p4-deny-allowed.jsonl`, seeded `[ls]`, `--approve=never`):
  `ls` ran, turn completed, zero approval frames.
- Unmatched (`41-p4-deny-unmatched.jsonl`, `pwd`, `--approve=never`):
  three identical cycles; each request carries the full choice set
  (allow_once / allow_local_prefix / abort) and resolves instantly:

```
2026-11-02T01:16:17.259Z S> approval/request  b86f68ba
2026-11-02T01:16:17.260Z S> approval/resolved b86f68ba
```

```json
{"decision":"denied","policyResult":"deny","resolvedBy":"policy",
 "decidedByCommandId":null,"amendment":null}
```

After the third denial the agent narrated the block ("that tool is
denied by policy in this session") and the turn completed. UI note:
requests appear and die instantly — render `resolvedBy: policy`
denials as settled facts, not pending prompts. (Whether a fast
`approval/decide` could win the race was not tested.)

## P5. Approval judge

**Answer: the judge runs under `muse serve` when the session profile
selects reviewer `autoReview`, and only then. Default here is
reviewer `none` (`:unrestricted` from local settings), so the judge
is OFF unless a profile opts in — there is no `--approval-judge`
flag on `serve`; the profile is the only knob.**

Command (`50-p5-autoreview.jsonl`, `:auto-review` + promptUnmatched,
`pwd`, `--approve=never` — completed with NO client decision):

```sh
bun tools/msp-capture.ts turn --provider meta \
  --workspace $TMPD/ws-p2 --muse-home $TMPD/muse-home-p5 --experimental \
  --approval-mode=promptUnmatched --permission-profile=:auto-review \
  --approve=never --out $CAPDIR/50-p5-autoreview.jsonl \
  --prompt="Run the command 'pwd' and report the output. Do not access the network."
```

Frames on the judge path (grep count of `approval/request` in `50`:
**0** — the client is never asked; there is no
`approval/requested` either):

```
S> approval/reviewing   (notification: full approval payload + taskId/toolCallId/judgeEscalated:false)
S> approval/updated     (change.kind=reviewStarted,  +6ms)
S> approval/updated     (change.kind=reviewCompleted, +1.0s)
S> approval/resolved    (decision=approved, policyResult=allow, resolvedBy=llmJudge,
                         stageEvidence[0].resolution.kind=allowOnce, decidedByCommandId=null)
```

The command then ran. Judge denials/escalations
(`judgeEscalated:true` → human prompt) were not exercised — no
dangerous command was offered to the judge.

## P6. Sandbox under serve

**Answer: yes, the shell is sandboxed under serve — but only when the
profile says so. `:unrestricted` (this machine's default) = no
sandbox: outside-workspace writes succeed and loopback+LAN egress is
free. `:ask-me`/`:auto-review`/`:read-only` = bubblewrap sandbox:
outside writes fail read-only, in-workspace writes pass, and network
destinations each raise a `network`-kind approval. `--sandbox-network
restricted` kills all egress at the OS level in every mode;
`--disable-sandbox` removes the sandbox even under `:ask-me`;
`--disable-write` withholds the file tools only.**

Listener reach matrix (own listener on 0.0.0.0:3000; `listener.log`
holds 8 HITs: ping×2, t1-lo, t1-lan, t2-lo, t2-lan, t6-lan, t4b-lo):

| capture | mode / profile / net flag | 127.0.0.1 | LAN .157 | outside write |
|---|---|---|---|---|
| `60`/`61` | onRequest / :unrestricted / proxy-only | REACH, no approval | REACH, no approval | SUCCEED, no approval (`61`, exact `touch`) |
| `63` | onRequest / :unrestricted / restricted | BLOCK exit 7, 0 hits | BLOCK exit 7 | — |
| `64` | promptUnmatched / :unrestricted / proxy-only | REACH after shell approval | REACH after shell approval | SUCCEED after shell approval |
| `65` | promptUnmatched / :unrestricted / restricted | BLOCK exit 7 | BLOCK exit 7 | — |
| `66` | onRequest / :ask-me / proxy-only | — | — | BLOCK read-only fs |
| `68` | onRequest / :ask-me / proxy-only, HOME ws | — | — | BLOCK outside; in-ws SUCCEED |
| `67` | onRequest / :read-only / proxy-only | — | — | write_file: `tool policy denied filesystem write`; shell: read-only fs |
| `69`/`70` | onRequest / :unrestricted / +`--disable-write` | — | — | write_file WITHHELD (`muse.write_file is not available`); agent refused shell touch twice — shell path untestable via agent, and the flag is documented non-shell-only |
| `71` | onRequest / :ask-me / +`--disable-sandbox` | — | REACH | SUCCEED (flag overrides profile; approval still passed per onRequest) |
| `72` | promptUnmatched / :ask-me / proxy-only | REACH after shell+network approvals | — | external TEST-NET curl: shell+network approvals, then exit 28 timeout (same 10 s timeout from our own shell — fate undetermined, consistent with unroutable) |

Approval vs sandbox, separated: under restricted, curl stages still
resolve `policyAllow` (`diagnostic: mode:on_request`, `62`) — the
block lands later, at the OS. Under `:ask-me`, every destination
raises its own approval (`72`): shell-kind for the command, then
network-kind:

```json
{"kind":"network","host":"127.0.0.1","port":3000,"protocol":"http",
 "toolName":"network","origin":{"kind":"shellCommand","command":"curl ... (display only)"}}
```

Network choices: `allow_once` / `allow_session` (`127.0.0.1:3000
(http)`) / `allow_local_network` (persistent) / `abort`. No
network-kind approval ever fired under `:unrestricted`.

Sandbox failure shape (`66-p6-askme-writes.jsonl`, `item/delta` +
`item/completed.failureReason`):

```
touch: cannot touch '/home/amm0bot/perm-outside-t7.txt': Read-only file system
The sandbox blocked a write to ...: it is outside this session's writable
roots (workspace, /tmp, $TMPDIR). Options: ask the user to allow it
(permission profile: "workspace_roots": {"<dir>": true}), ...
```

Quirks found live: (1) workspaces on `/dev/shm` (tmpfs) get a
**fully read-only** sandbox — even in-workspace `touch` failed in
`66`, while the identical probe on a `$HOME` workspace (`68`)
passed in-ws and blocked outside; (2) under a sandboxed profile the
shell sees cwd as `/` (`50`: wire `visibleOutput` for `pwd` is
`"/\n"`, vs the real path under `:unrestricted` in `82`);
(3) agents decorate commands (`; echo exit:$?`) — the unparseable
tail holds the whole command (`60`, `62`) and drops the persist
choice (choices shrink to allow_once/abort).

`session/userShell` (TUI `!` hatch; `userShell` capability granted
over stdio spawn): approval-free in every mode (no approval frames
in `76-p6-usershell-prompt.jsonl` under promptUnmatched),
**sandboxed** like agent shell (`75`: outside touch → read-only fs,
`kind:userShell` item with `visibleOutput`), and unaffected by
`--disable-write` (`73`: in-ws touch succeeded).

## P7. MCP tool approvals

**Answer: choice set `allow_once` / `allow_session` /
`allow_local_mcp_tool` / `abort`; the persistent rule is
`kind: tool_action` naming the namespaced tool — with NO workspace
scope (global). A second session calls it prompt-free.**

Command (`90-p7-mcp-persist.jsonl`, sessionMcp + `mcp-config.json`,
promptUnmatched, `--approve=persist`):

```sh
XDG_CONFIG_HOME=/home/amm0bot/cfgtest-p7 bun tools/msp-capture.ts turn \
  --provider meta --workspace $TMPD/ws-min --muse-home $TMPD/muse-home-p7 \
  --capabilities=sessionMcp --mcp-config $CAPDIR/mcp-config.json \
  --approval-mode=promptUnmatched --approve=persist \
  --out $CAPDIR/90-p7-mcp-persist.jsonl \
  --prompt="Call the ui_show_note tool with text 'hello persist'. Report exactly what it returned. ..."
```

Subject/choices (`90`): `subject.kind=tool`,
`toolName=mcp__wire_probe__ui_show_note`; persist choice
`allow_local_mcp_tool` → `approvedPolicyAmendment`. Rule written:

```json
{"effect":"allow","durability":"local_persistent",
 "rule":{"kind":"tool_action","tool_name":"mcp__wire_probe__ui_show_note"}}
```

Rerun (`91-p7-mcp-again.jsonl`, new session, `--approve=never`):
`noted: second call`, zero approval frames.

## P8. `--trust-workspace` side effects

**Answer: trust gates project skills + rules (B1) and project hooks —
both registration AND execution verified. It does NOT load any MCP
config under serve. Project memory loads even untrusted. `trust.json`
is TUI memory that serve ignores.**

- Hooks: `<ws>/.muse/hooks.json` (Claude-Code layout:
  `{"hooks":{Event:[{matcher,hooks:[{type:command,command}]}]}}`).
  `hook/list` trusted (`80`): two rows, `handlerKind: project`,
  `enabled: true`. Untrusted (`81`): same rows, `enabled: false`.
  Execution (`82`, trusted turn): `SessionStart` + `PreToolUse`
  both fired (log file got both lines; SessionStart fires at first
  turn, not at `session/start` — the no-turn raw probes fired
  nothing). Row key shape:
  `<ws>/.muse/hooks.json:pre_tool_use:def-f6b77f06856f3044`.
- MCP config: NOTHING loads under serve — trusted `.mcp.json`
  (`84`), user settings `mcpServers` camel (`85`) and `mcp_servers`
  snake (`86`) all yield `mcpServer/list → {"servers":[]}`, with and
  without `sessionId` (`87`), no child process spawned, no stderr
  warning. Only wire `sessionMcp` + `config.mcpServers` works (B2,
  P7). Docs agree (settings-file declaration is TUI-facing).
- Memory: untrusted session (`88`) already sees the project memory
  *index* (`MEMORY.md` content + `deploy.md` listed) without reading
  files; topic contents load on demand. Docs-flagged injection
  surface, confirmed live.
- `trust.json` (`~/.config/muse/trust.json`):
  `{"schema_version":1,"projects":{"/home/amm0bot":{"decision":"trusted"},...}}`.
  Serve does NOT consult it: workspace `~/ws-trustprobe` under a
  trusted root still lists hooks `enabled: false` without the flag
  (`83`). Trust under serve is exactly the `--trust-workspace`
  process flag (socket daemons: per-session choice under
  `--allow-workspace-trust`, untested).
- Never workspace-injectable: approval rules (config home only, P1),
  profiles/trust themselves, settings.

Doc-backed (not live-probed): instruction walk-up to the `.git`
boundary (`AGENTS.md`, `CLAUDE.md`, `.agents/AGENTS.md`,
`.claude/CLAUDE.md`, deeper wins); hooks run **outside**
sandbox+approval with a cleared env; MCP servers run unsandboxed
(child process / direct socket) with approval still applying.

## D44: private muse config home (round 2)

Our workers spawn with
`XDG_CONFIG_HOME=<dataHome>/routeros-muse/.muse-config/<workspace-id>`
(D44, T101 round 2; per-workspace layout and the leading dot are round
4, D45 — see below). Inside each home, `muse/` holds our own
`approval-policy.json` (schema v2, same tagged `reason:"routeros-muse:seed"`
rules), our own minimal `settings.json` (`{"schema_version":1}` — unknown
fields make muse exit 3, verified with a real boot), and an `auth.json`
SYMLINK to the real `${XDG_CONFIG_HOME:-$HOME/.config}/muse/auth.json`,
re-ensured on every spawn. The shared `~/.config/muse/` is never written.
Dirs are 0700; symlinks at or below `<dataHome>/routeros-muse` are
refused (round 4 also covers `.muse-config` and `<workspace-id>`).

Why: muse persists approval-policy.json without a lock, so sharing the
file with other agents on the box risks dropping a rule in the
rename window (a foreign deny was lost in a probe); a malformed file
bricks every muse on the box (exit 3); network host rules are
machine-global and need owned state. The private home removes the
shared-file race and the blast radius in one move.

Auth shape (orchestrator probes 2026-11-02): auth.json holds a static
token (no refresh token, no expiry field), so link-per-spawn carries
no rotation risk; the muse binary reads auth only from
`$XDG_CONFIG_HOME/muse/auth.json` (`MUSE_AUTH_PATH` is launcher-only).
If the real auth.json is absent, sessions fail turns with
`authRequired` (the existing boot-probe/banner path) and Settings
carries a "not signed in" warning.

Network-rule ownership: rounds 2–3 used the UNION of router.toml
device hosts over registered workspaces (registry.toml), recomputed
at boot, toggle, router.toml save, workspace create, and registry
prune. REMOVED in round 4 (D45): each workspace seeds only its own
hosts into its own home; tagged network rules outside that set are
pruned. Untagged rules (the owner's own Always-allow choices) are
never touched, in every round.

Read set as amended 2026-11-02: exactly `centrs retrieve`,
`quickchr list`, `quickchr doctor`. Dropped: find (-exec/-delete),
rosetta browse (writes its DB), ls/cat/grep (not workspace-confined).
On `centrs retrieve` (developer decision 2026-11-02): centrs is a
helper, not routeros-muse's security layer — RouterOS only reveals
RO/RW/policy at run time, so the seeded rule trusts centrs's
read/write split (reads run, writes need --yes). The known
fragment-path reboot bug is C19 (tikoci/centrs#586), open upstream. Anyone who
needs "never reboot" should use a restricted RouterOS account —
that is the real boundary for strict setups.
Housekeeping, documented not alarming: `quickchr list`/`doctor`
call refreshAllStatuses(), which rewrites stale LOCAL machine
state (clears dead PIDs/frozen markers) — bookkeeping under
`~/.config/quickchr`, no device contact, acceptable in the read set.

Concurrency: all seeding serializes in-process (one mutex; the path
is fully synchronous so run-to-completion does the work and the
guard makes it explicit). Round 3 added a cross-process lock file
next to the policy (`approval-policy.json.lock`); REMOVED in round
4 (D45) after a re-review confirmed four defects in it — per-workspace
homes made it unnecessary. What stays: the in-process mutex and the
reread-before-rename guard with retries. Residual window: a live
muse session persisting an Always-allow into our private file
writes WITHOUT a lock and WITHOUT a re-read, so it can still
clobber a seed (or a seed can clobber it) when the two land in the
same instant — smaller than round 1 (only our own workers write
this file now, not every agent on the box), but not zero.
Convergence is eventual: the next boot/toggle/edit re-seeds our
tagged set over whatever the file holds, and muse re-persists
owner choices on next approval.

Fail-closed (round 3): when the private home itself is rejected
(symlink anywhere in the `<dataHome>/routeros-muse` down-chain),
the seed is skipped — never write through a refused link — and no
worker spawns with it (the session start fails with the reason;
never falls back to the shared `~/.config/muse`). The reason
lands in the status `preallow.homeError`, the warnings, and the
boot log.

Shell environment (probed 2026-11-02, muse 1.4.14): the agent's
shell tools INHERIT the serve process environment, including
XDG_CONFIG_HOME — verified live (`session/userShell` under a
sandboxed profile echoed the fake home back). There is NO clean
user-settable mechanism to restore/exclude it for tool execution:
`session/start.config` admits only `mcpServers` (binary-exported
MSP schema, both surfaces); `settings/readSchema` lists no env key;
`serve -c environment_policy=...` (and execution./shell./sandbox.
variants) refuse as unknown keys; `environment_policy`
(inherit/include_only/exclude) is an internal executor field fed by
the permission-profile definition, and profile definitions below
the fixed native rows exist only via enterprise policy planes
(`muse config status` here: both absent; managed files are
root-owned system files). Blast radius, bounded by source reads:
centrs CDB resolution is `$HOME`-based (unaffected), quickchr state
is `$HOME/.config/quickchr` (unaffected), rosetta reads no
XDG_CONFIG_HOME (unaffected) — only centrs' user-global
`centrs.env` settings (resolved under XDG_CONFIG_HOME) do not apply
to agent-run centrs commands (on orca that file carries
CENTRS_SSH_KEY, so SSH transport would lose its key).

Resolution (orchestrator, 2026-11-02): the private home links the
trilogy's config dir through — `<private>/tikoci -> <real config
home>/tikoci`, re-ensured on every spawn like auth.json
(`LINKED_TOOL_CONFIG_DIRS`), skipped when the real dir is absent,
and a real directory already there is kept with a warning. Live
(`~/t101b-live/cap/tikoci-link.jsonl`, real muse 1.4.14, meta,
:unrestricted): the tool shell's XDG_CONFIG_HOME is the private
home, and `centrs settings print` reports CENTRS_SSH_KEY from the
real centrs.env; ~/.config/muse mtimes unchanged.

Rejected, with evidence: BASH_ENV restore scripts. The `muse`
launcher is a bash script and sources BASH_ENV itself before
exec'ing the binary (probed: the hook ran with $0 = the launcher),
so an unguarded restore hands muse the shared config home; and
muse's tool shells never source BASH_ENV at all (traced: only the
launcher's line was logged), so a guarded one does nothing.

Known residual: other XDG-aware tools the agent runs (gh's
`$XDG_CONFIG_HOME/gh`, git's XDG config, mise) see the private home;
git still reads ~/.gitconfig. Not linked: GitHub stays the
developer's call (D34), and each extra link widens what the private
home exposes. An upstream per-session env surface in MSP would
remove the need for links.

## D45: one private home per workspace (round 4)

Rounds 2–3 kept ONE private home for every workspace
(`<dataHome>/routeros-muse/muse-config/`), which needed the
cross-workspace host union and the cross-process seed lock. Round 4
(D45) gives each workspace its own home:

`<dataHome>/routeros-muse/.muse-config/<workspace-id>/`

- `<workspace-id>` is `<sanitized-basename>-<hash12>`: the
  workspace dir's basename (readable) plus 12 hex chars of sha256
  over the canonical absolute root (realpath; path.resolve when
  unresolvable). Stable across spellings of the same root; a MOVED
  workspace gets a NEW home — accepted by design, and seeding
  recreates its rules from scratch on next boot.
- The leading dot marks the dir as managed, not for user editing;
  it is not a security measure.
- No-workspace mode (D23) gets the fixed
  `.muse-config/_no-workspace/` home (settings + auth link; nothing
  seeded — there is no router.toml to seed from).
- Each home holds its own `muse/approval-policy.json`,
  `muse/settings.json`, the `muse/auth.json` link and the `tikoci`
  link, with round-2/3 semantics: re-ensured per spawn, 0600/0700,
  dangling real auth warns.
- The seed lock is GONE entirely: no lock file, no acquire/release,
  no stale logic, no SEED_LOCK_* constants, no race worker. The
  in-process mutex and the reread-before-rename guard stay.
- The registry host union is GONE: each workspace seeds ONLY its
  own router.toml hosts. Re-seed triggers are boot, the Settings
  toggle, and router.toml saves. Cost accepted: an Always-allow
  clicked in one workspace does not carry to another.
- Two servers on the same workspace: WARN ONLY via a `server.pid`
  file in that workspace's home. No blocking, a stale pid is
  silently ignored, symlinks are never followed (neither read nor
  replaced), and correctness never depends on it.
- Chain safety: refuse a symlink at or below
  `<dataHome>/routeros-muse`, now including `.muse-config` and
  `<workspace-id>`; symlinks above it stay allowed. Fail closed:
  no seeding and no spawn on an unsafe home, the reason in status
  and session start, never a fallback to the shared
  `~/.config/muse`.
- Settings/status shows this workspace's private home path
  (`preallow.configHome`).
- The round-2/3 flat `muse-config/muse/` layout is an orphan from
  development builds — it never shipped. Left alone: never
  migrated, never deleted.

Round-4 also fixed the agent auth check (`src/steps/agent.ts`):
it hardcoded `~/.config/muse/auth.json` and now shares one
`museAuthFile()` helper with the private-home linker
(`$XDG_CONFIG_HOME/muse/auth.json`, else `~/.config` — the muse
launcher's own order, verified in its script; an empty
XDG_CONFIG_HOME falls back like the launcher's `-n` test). win32
keeps `%APPDATA%`, unverified (no Windows probe; the Linux
binary's strings show no APPDATA use for muse's own config).

## Option C verdict: FEASIBLE

Pre-allowing our designed read set under promptUnmatched works via
the P2 path-(b) mechanism: **`routeros-muse start` (or init)
pre-writes `$XDG_CONFIG_HOME/muse/approval-policy.json`** with one
`shell_command_argv_prefix` rule per read command, each scoped to
the workspace's absolute root:

```json
{"schema_version":2,"rules":[
 {"effect":"allow","durability":"local_persistent",
  "rule":{"kind":"shell_command_argv_prefix",
          "argv_prefix":["centrs","retrieve"],"workspace_root":"<ws>"},"reason":null},
 {"effect":"allow","durability":"local_persistent",
  "rule":{"kind":"shell_command_argv_prefix",
          "argv_prefix":["quickchr","list"],"workspace_root":"<ws>"},"reason":null}
]}
```

Concrete read set (each its own two-word prefix; never the bare
binary — `[quickchr]` would also free `quickchr remove`):
`centrs retrieve`, `rosetta` (+ subcommand words as needed),
`quickchr list`, `quickchr doctor`, `ls`, `cat`, `grep`, `find`.
AMENDED in round 2 (see the D44 section above): the live set is
`centrs retrieve`, `quickchr list`, `quickchr doctor`.
Still prompting, live-verified: `centrs execute` (second word
differs — P3 both directions), any write outside the workspace
(shell approval under promptUnmatched; hard-blocked by the sandbox
under `:ask-me` regardless), network tools (`curl` always raises
shell-kind; destinations add network-kind under sandboxed profiles).

Caveats, all grounded: (1) `--yes` cannot be excluded — keep
`centrs execute` fully unlisted (P3). (2) Rules pin the absolute
`workspace_root` — rewrite on move/rename. (3) Rules live in
user-machine state, not the repo — the CLI must ensure them at
start; config home must be default or under `$HOME` (P2). (4) Pair
with profile `:ask-me`: under this machine's `:unrestricted`
default there is no sandbox, so an approved outside-write SUCCEEDS
(P6). (5) `sh -c` wrapping cannot smuggle `execute` past a
`retrieve` rule — the grammar unwraps it (P3). (6) When rosetta MCP
lands, its tools need `tool_action` rules, which are global, not
per-workspace (P7).

## SECURITY.md notes (factual outline)

Modes (approval layer): `onRequest` passes recognized non-dangerous
stages (`policyAllow`, `diagnostic: mode:on_request`) and holds the
rest; `promptUnmatched` holds every unmatched stage; `denyUnmatched`
emits the request but policy auto-denies same-ms (`resolvedBy:
policy`); `allowAll` (profile axis) prompts nothing. In-workspace
`write_file`/`edit_file` pass in any mode (docs; `67` shows
`:read-only` excepts via `tool policy denied`).

Profiles (sandbox + reviewer layer): `:unrestricted` = no sandbox,
full egress, no reviewer; `:ask-me` = bubblewrap (writable roots:
workspace, `/tmp`, `$TMPDIR`), per-destination network approvals,
human review; `:auto-review` = same + LLM judge auto-clears eligible
calls (`resolvedBy: llmJudge`, no client frames); `:read-only` =
reads + no side effects. Default = `settings.json`
`permissions.default_profile` (`:unrestricted` here; TUI ships
Auto-review per docs). Serve flags override per axis:
`--sandbox-network restricted` (no egress), `--disable-sandbox`
(no confinement + full egress + file tools unconfined),
`--disable-write` (file tools withheld), `--disable-shell`
(untested).

Where trust and rules live:

| what | where | who writes |
|---|---|---|
| allow rules | `$XDG_CONFIG_HOME/muse/approval-policy.json` (0644) | approval decisions, our CLI (pre-seed) |
| default profile, model, MCP (TUI) | `$XDG_CONFIG_HOME/muse/settings.json` | user, `settings/writeValue` (exp) |
| remembered trust | `$XDG_CONFIG_HOME/muse/trust.json` | TUI only; serve ignores it |
| session logs, index | `$XDG_DATA_HOME/muse/` | serve |
| project skills/rules/hooks/memory | `<ws>/.agents/skills`, `AGENTS.md`, `<ws>/.muse/hooks.json`, `<ws>/.agents/memory` | repo (trusted: all but memory need `--trust-workspace`) |

Residual risks: hooks execute outside sandbox+approval (cleared env
only) once trusted; memory index loads untrusted; MCP servers are
unsandboxed processes; `session/userShell` is approval-free (needs
the `userShell` capability); `:auto-review` silently clears
judge-eligible calls; `denyUnmatched` requests still reach clients;
`/dev/shm` workspaces sandbox to fully read-only (availability, not
escape); seeded rules are invisible in-repo state that must be
reconciled, never assumed; interpreter allowlists are refused (good).

## What was NOT determined

- Judge denials/escalations (`judgeEscalated:true` path) — no
  dangerous command was offered to the judge.
- Whether a fast `approval/decide` can beat a `denyUnmatched`
  policy denial.
- Deny rules and `shell_command_exact_raw` / `filesystem` rule kinds
  live (docs + binary only).
- User/managed profile definitions via enterprise planes; the
  `workspace_roots` profile key from the sandbox failure text.
- Why `XDG_CONFIG_HOME` off `$HOME` breaks meta auth (boundary only).
- External-egress packet fate post-approval (TEST-NET timeout is
  indistinguishable from unroutable).
- `--disable-shell`, socket-daemon trust (`--allow-workspace-trust`),
  TUI-side MCP/hooks behavior (serve-tested only).
- `session/setApprovalMode` / `session/setPermissionProfile`
  mid-session transitions (schema-read, never called).

## Capture inventory

`00` smoke; `01`–`07`,`22` profiles/settings/config-home;
`10`–`13` P1; `20`–`21` P2 seeding; `30`–`33` P3;
`40`–`41` P4; `50` P5; `60`–`76` P6 (+`listener.log`);
`80`–`88` P8; `90`–`91` P7 (+`mcp-config.json`,
`mcp-server-p7.jsonl`, `p1-policy-file.json`, `p1-before/after.txt`).
