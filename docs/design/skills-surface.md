# Skills surface — how muse discovers and reports skills (2026-11-02)

Research for T100 (package-level skills) and K30 (one managed home).
Every claim below comes from a wire capture, a CLI transcript, or a
binary-exported schema in the stamp dir — never memory. Zero model
turns were used: all questions answered with `skill/list` and other
non-model probes.

- `muse --version`: `Muse Code 1.4.14 (1.4.14-R7309.1)` (same as B1/B3)
- Capture dir (main checkout, gitignored, never committed):
  `out/wire-capture/skills-20261102T000830Z/`
- Capture tool (committed): `tools/msp-capture.ts` — extended with
  `skills-reread`, `--muse-config-home`, `--home`, `--dump-skills`,
  `--set-activation`, `--import-dry-run`, plus `plugin/list`/`hook/list`
  in `session-probe`. Prototype check: `tools/skill-check.ts`.
- Isolation: `HOME`, `XDG_DATA_HOME`, and `XDG_CONFIG_HOME` all pointed
  at temp dirs, so probes never touch the real user roots, session log,
  or settings. Real `~/.agents/skills` and `~/.local/share/muse` were
  only ever read (never written) for the S2/S5 layout survey.
- Workspaces: temp dir `/dev/shm/skills-3170819/` (deleted after),
  `ws-min`/`ws-net` from `bun src/index.ts init --template`, plus
  `ws-shadow`, `ws-bad` fixtures. All commands below run from repo root
  with `TMPDIR=$TMPD`.
- Schema: fresh `muse schema` export into the stamp dir, byte-identical
  to the `20261101T210403Z` export (same binary).

## Capture inventory

| File | Command (abridged) | What it proves |
|---|---|---|
| `schema-ts/msp.d.ts`, `schema-json/`, `schema-ts-exp/`, `schema-json-exp/` | `muse schema generate-*` | S1: stable + experimental surface |
| `01-baseline-min.jsonl`, `01-baseline-min-skills.json` | `session-probe` min trusted, temp homes | 14-row baseline: 12 bundled + 2 plugin |
| `02-net-55.jsonl`, `02-net-55-skills.json` | `session-probe` net + 55 staged | S6: 55/55 project rows, 69 total |
| `03-validation-matrix.jsonl`, `03-validation-matrix-skills.json` | `session-probe` ws-bad trusted | S6: broken skills silently absent |
| `04-setactivation-off.jsonl` | `session-probe --set-activation s4-new,project,off` | S1: accepted, same-session list stale |
| `04b-fresh-after-off.jsonl` | fresh `session-probe` | off removes row in new sessions |
| `04c-userinvocable.jsonl`, `04d-fresh-after-uio*.jsonl` | set `userInvocableOnly` + fresh probe | state present in list again |
| `05-import-dryrun.jsonl`, `05b-import-dryrun-full.jsonl` | `--import-dry-run claude` (empty, then staged `~/.claude/skills/fake-one`) | S1: foreign dir is `$HOME/.claude/skills` |
| `06-shadow*.jsonl`, `06b-shadow-user*.jsonl` | user+project `shadow-skill`, then `only-user` control | S3: project > user; `$HOME` override works |
| `06c-shadow-bundled.jsonl` | project `grill` over bundled `grill` | S3: project > bundled |
| `06d-user-vs-bundled.jsonl` | user `grill` over bundled `grill` | S3: user > bundled |
| `06e-project-vs-plugin.jsonl` | project `threejs` over plugin `threejs` | S3: project takes bare selector, qualified survives |
| `07-reread.jsonl` | `skills-reread` add+edit+delete, 5 s settle | S4: same session sees all three + `skill/changed` |
| `07b-reread-fresh.jsonl` | fresh probe after mutation | S4: delete unmasks user copy |
| `08-plugin-installed.jsonl` | probe after user-scope plugin install | S5: 2 rows (bare + qualified), `plugin/list` = 1 |
| `08b-plugin-scope-min.jsonl`, `08c-plugin-scope-shadow.jsonl` | probes on install site vs other ws | S5: project-scope install visible everywhere |
| `08d-plugin-notrust.jsonl` | untrusted probe | S5/S3: user+plugin+bundled load untrusted |
| `09-cli-skills-list-temp.json` | `muse skills list --json` (temp env) | S2: full catalog 26 rows + row shape |
| `09-cli-skills-list-net55.json` | same on ws-net | S6: 81 rows, 0 diagnostics, all `on` |
| `09-cli-skills-list-shadow.json` | same on ws-shadow | S3: `$HOME/...` vs relative paths |
| `09-cli-skills-list-bad.json` | same on ws-bad | S6: 5 top-level diagnostics |
| `09-cli-after-deactivation.json` | same after setActivation off | S1: `activation: off` persisted |
| `09-cli-inspect-ok.json` | `muse skills inspect ok-control --json` | S2: inspect shape (frontmatter split) |
| `10-plugin-*.json` | validate/install/list/inspect transcripts | S5: bundle format, cache path, lockfile |
| `11-validate-*.json` | `muse skills validate <dir> --json` × 8 | S6: accept/reject rules + messages |
| `12-skill-check-clean.txt`, `12-skill-check-bad.txt` | `tools/skill-check.ts` runs | S2: prototype exit 0 / exit 1 |

## S1. The `skill/*` (and related) MSP method surface

**Answer: three stable methods, none experimental-only, and no
add/enable/install/reload op. `skill/setActivation` (on /
userInvocableOnly / off per scope) is the only enable/disable seam;
`skill/import` imports foreign (`claude`/`codex`) skills only. The
surface is otherwise list-only; install/enable/validate/update/
uninstall exist only as local `muse skills|plugins` CLI twins, not on
MSP.**

Stable methods touching skills (from `schema-ts/msp.d.ts` line 4023
`MspMethod`, confirmed in `schema-json/msp.schema.json`):

- `skill/list`, `skill/setActivation`, `skill/import`
- related: `hook/list`, `plugin/list`, `plugin/install`,
  `plugin/marketplaceAdd`, `plugin/marketplaceUpdate`,
  `plugin/marketplaceRemove`
- notifications: `skill/changed`, `plugin/changed`,
  `plugin/marketplaceChanged` (re-list hints, carry no rows)

The experimental export adds no `skill/*` method (method-name diff of
`schema-ts/` vs `schema-ts-exp/` shows only account/admission/log/mcp/
peer/projection/settings/usage/limits additions). `SkillCatalogEntry`
is identical in both.

Live behavior of the two writes (both previously unexercised):

- `skill/setActivation {selector: s4-new, scope: project, activation:
  off}` → `accepted`, `previous: on`. The same-session `skill/list`
  still shows the row (stale; no `skill/changed` emitted — zero in
  `04`). A fresh session drops to 17 rows with no `s4-new` (`04b`).
  State persisted to `$XDG_CONFIG_HOME/muse/settings.json`
  (`skills.activation.projects.<ws-root>.<rel-path>`, kebab-case
  `user-invocable-only` on disk vs camelCase on the wire).
  `userInvocableOnly` keeps the row listed (`04d`).
- `skill/import {source: claude, dryRun: true}` → `accepted` with
  zero counts on an empty temp HOME (`05`); after staging
  `$HOME/.claude/skills/fake-one/SKILL.md` it reports
  `installed: ["fake-one"]` (`05b`) — so the host-resolved foreign
  dir honors `$HOME`.

Command:

```sh
bun tools/msp-capture.ts session-probe --provider meta \
  --workspace $TMPD/ws-shadow --muse-home $TMPD/muse-home \
  --muse-config-home $TMPD/muse-config --home $TMPD/fake-home \
  --serve-args="--trust-workspace" --set-activation "s4-new,project,off" \
  --out out/wire-capture/skills-20261102T000830Z/04-setactivation-off.jsonl
```

Excerpt (`04-setactivation-off.jsonl` response frame):

```json
{"activation":"off","commandId":"01a19999-9b90-7255-836f-7231235f0b99",
 "previous":"on","scope":"project","selector":"s4-new","status":"accepted"}
```

For contrast, the CLI-only surface (no MSP twin; from
`muse skills --help`): `list [--source …|--enabled-only]`, `inspect`,
`enable`, `user-only`, `disable`, `validate`, `install`,
`import --from claude|codex`, `update`, `uninstall` — plus
`muse plugins install|list|inspect|approve|reject|enable|disable|
update|remove|validate|marketplace …`.

## S2. What `skill/list` reports per row

**Answer: far less than the question hopes. MSP rows carry
`selector`, `source`, `description`, `displayName`, plus optional
`pluginId`, `argumentHint`, `title` — and NO path, NO
enabled/activation flag, and NO errors. Worse, `skill/list` is not the
full catalog: it lists only the typed-invocable subset (skills without
`user-invocable: false`). A host CAN compare selectors against an
expected set (prototype: `tools/skill-check.ts`), but the `errored`
and `enabled` legs need the CLI full catalog
(`muse skills list --json`), which adds `path`, `activation`,
per-row and top-level `diagnostics`, `id`, `scope`, `context_cost`,
and `provenance`.**

Row-shape evidence (`01-baseline-min-skills.json`, key union over all
rows): `argumentHint, description, displayName, pluginId, selector,
source`. No row carried `title` (no staged skill declares
`metadata.display-name`).

Subset evidence: 26 bundled skill dirs exist under
`~/.local/share/muse/skills/bundled/muse-core/skills/`, the CLI lists
all 25 bundled + 1 plugin row (`09-cli-skills-list-temp.json`), but
MSP lists only 12 bundled + 2 plugin spellings (`01`). All 13
CLI-only bundled skills declare `user-invocable: false`; all 12
MSP-listed ones lack the key (verified by grep over the shipped
bodies). The schema agrees: `skill/list` = "one row per
typed-invocable shortcut spelling", `skill/changed` = "the session's
user-invocable set changed".

Command:

```sh
bun tools/msp-capture.ts session-probe --provider meta \
  --workspace $TMPD/ws-min --muse-home $TMPD/muse-home \
  --muse-config-home $TMPD/muse-config --home $TMPD/fake-home \
  --serve-args="--trust-workspace" \
  --out out/wire-capture/skills-20261102T000830Z/01-baseline-min.jsonl \
  --dump-skills out/wire-capture/skills-20261102T000830Z/01-baseline-min-skills.json
```

Excerpt (`01-baseline-min-skills.json`, a plugin row — the richest shape):

```json
{"description":"Three.js 3D reference hub. Use when working with Three.js: ...",
 "displayName":"threejs","pluginId":"threejs",
 "selector":"threejs:threejs","source":"plugin"}
```

Prototype (`tools/skill-check.ts`, committed): `compareMspSkills`
reports `missing` (expected project names with no `[project]` row)
and `unexpected` (unlisted `[project]` rows); `collectCliErrors`
reports `errored` from CLI diagnostics. Caveat, grounded in S6: the
expected set must use frontmatter `name` (it wins over the directory
name; a missing `name` falls back to the directory). Clean run exits
0 (`12-skill-check-clean.txt`); the ws-bad run exits 1 with 56
missing / 3 unexpected / 5 errored (`12-skill-check-bad.txt`).

## S3. Discovery roots and precedence

**Answer: four roots. Project `<ws>/.agents/skills` (trust-gated),
user `$HOME/.agents/skills` (always loaded), bundled skills embedded
in the binary (materialized under `$XDG_DATA_HOME/muse/skills/
bundled`), and plugins (builtin + installed, materialized under
`$XDG_DATA_HOME/muse/plugins/cache/`). Precedence is project > user >
bundled; a same-name project skill also steals the plugin's bare
selector while the `plugin:skill` qualified spelling survives.
`$HOME` redirection fully moves the user root (positive control:
`only-user` from the temp HOME lists as `[user]`).**

Commands (staged fixtures, then):

```sh
bun tools/msp-capture.ts session-probe --provider meta \
  --workspace $TMPD/ws-shadow --muse-home $TMPD/muse-home \
  --muse-config-home $TMPD/muse-config --home $TMPD/fake-home \
  --serve-args="--trust-workspace" \
  --out out/wire-capture/skills-20261102T000830Z/06b-shadow-user.jsonl \
  --dump-skills out/wire-capture/skills-20261102T000830Z/06b-shadow-user-skills.json
```

Excerpts:

- `06-shadow-skills.json`: one `shadow-skill` row, `source: project`,
  `description: PROJECT-VERSION…` — the user copy is fully shadowed
  (the full CLI catalog also shows a single project-scoped row).
- `06b`: `only-user [user]` appears — the temp-HOME user root loads.
  CLI path strings (`09-cli-skills-list-shadow.json`): user root is
  `$HOME/.agents/skills/only-user/SKILL.md`, project root is
  workspace-relative (`.agents/skills/…`).
- `06c`: project `grill` replaces bundled `grill` (row count unchanged,
  17). `06d`: user `grill` replaces bundled `grill` (`[user]`).
- `06e`: project `threejs` takes the bare selector; the qualified
  `threejs:threejs [plugin]` row survives alongside it.
- `08d-plugin-notrust.jsonl` (no `--trust-workspace`): user + plugin +
  bundled rows all load (21 rows); only project rows are trust-gated.
- `museHome` in the `initialize` result is
  `$XDG_DATA_HOME/muse` (`01-baseline-min.jsonl`); first run
  materializes `skills/bundled/` + `plugins/cache/builtin/` there —
  it is a cache, not an authoring root.

## S4. Mid-session add / edit / delete

**Answer: a running session sees all three immediately, with no
reload step. `skill/list` re-reads from disk on every call, and file
mutations emit `skill/changed {sessionId}`. A new session trivially
sees the final state. The one stale case is `skill/setActivation`,
which emits no `skill/changed` and only takes effect in new sessions
(see S1).**

Command (new `skills-reread` subcommand applies file ops between two
`skill/list` calls on one session):

```sh
bun tools/msp-capture.ts skills-reread --provider meta \
  --workspace $TMPD/ws-shadow --muse-home $TMPD/muse-home \
  --muse-config-home $TMPD/muse-config --home $TMPD/fake-home \
  --serve-args="--trust-workspace" --mutate-json $TMPD/mutate.json \
  --settle-ms 5000 \
  --out out/wire-capture/skills-20261102T000830Z/07-reread.jsonl
```

Excerpt (`07-reread.jsonl` stdout): list #1
`17 rows (2 project): only-project,shadow-skill`; after add `s4-new`
+ edit `only-project` description + delete `shadow-skill`, list #2
(same session) `18 rows (2 project): only-project,s4-new` with the
edited description, plus 1 `N:skill/changed` during settle. Follow-up
(`07b-reread-fresh.jsonl`): a fresh session shows the user-root
`shadow-skill [user]` unmasked by the project delete.

Not probed: whether an already-running *model turn* picks up the new
catalog mid-turn (would need a model turn; the host contract —
re-list + `skill/changed` — is what a host can rely on).

## S5. How plugins work

**Answer: a plugin is a directory with a `.muse-plugin/plugin.json`
manifest (schemaVersion 1) declaring capability families `skills`,
`commands`, `hooks`, `mcpServers`, `reminders` (per the shipped
`create-plugin` skill doc). It installs with
`muse plugins install <path> [--scope user|project]` (or MSP
`plugin/install`, not exercised live) into a content-hashed cache
under `$XDG_DATA_HOME/muse/plugins/cache/local/<id>/<sha>/package`,
recorded in `.../plugins/installed.json`. Each carried skill yields
TWO `skill/list` rows — bare `name` and qualified `plugin:name` —
with `pluginId` set; `plugin/list` returns one record per plugin
(`{enabled, id, source: nativeLocal, version}`). Builtin plugins
(`threejs`, `muse-core`) ship in the binary and materialize under
`plugins/cache/builtin/`; they contribute skill rows while
`plugin/list` stays empty. routeros-muse COULD ship a skills plugin,
but it is not an alternative to copying: installs are machine-global
(`--scope project` wrote no workspace file and the plugin stayed
visible in every workspace probed), need an explicit install step per
machine, and load regardless of workspace trust.**

Minimum viable bundle (probed, `10-plugin-validate.json`:
`valid: true`, zero diagnostics):

```json
{"schemaVersion":1,"name":"tikoci-probe","displayName":"…","version":"0.1.0",
 "description":"…","compat":{"source":"native","manifestDir":".muse-plugin"},
 "capabilities":{"skills":[{"id":"probe-carried","path":"skills/probe-carried/SKILL.md"}],
  "commands":[],"hooks":[],"mcpServers":[],"reminders":[]}}
```

Commands:

```sh
muse plugins validate $TMPD/probe-plugin --json          # → 10-plugin-validate.json
muse plugins install $TMPD/probe-plugin --scope user --json  # → 10-plugin-install-user.json
bun tools/msp-capture.ts session-probe … --workspace $TMPD/ws-min … \
  --out out/wire-capture/skills-20261102T000830Z/08-plugin-installed.jsonl
```

Excerpts (`08-plugin-installed.jsonl` stdout): `skill/list: 19 rows`
with `probe-carried [plugin]` + `tikoci-probe:probe-carried
[plugin]`; `plugin/list: 1 rows` with
`{"enabled":true,"id":"tikoci-probe","source":"nativeLocal",
"version":"0.1.0"}`. Install receipt (`10-plugin-install-user.json`):
`cache_path: …/plugins/cache/local/tikoci-probe/d5010aa1…/package`,
`trust: user-local`. Project-scope surprise (`08b` vs `08c`):
`tikoci-probe-p`, installed with `--scope project` from `ws-min`,
lists its skill rows and `plugin/list` record identically in
`ws-shadow` — no confinement observed; `installed.json` carries no
scope marker and the workspace gained no files.

Not probed live: marketplace add/update/remove/install-from-marketplace
(schema + CLI help document them), MSP `plugin/install`, and plugin
`approve`/`reject` capability gating.

## S6. Skill validation

**Answer: strict on structure, silent on the wire. `muse skills
validate` rejects (exit 1): bad `name` (`install-path-unsafe`),
missing `description`, missing/unparseable frontmatter, missing
SKILL.md, and files over 262144 bytes (`invalid-skill-package` /
`skill-file-too-large`). A missing `name` is VALID (directory name
is the fallback); the frontmatter `name` wins over the directory
name. In `skill/list`, broken skills are silently ABSENT — no error
rows, no flags. Errors surface only in the CLI full catalog as
top-level `diagnostics` (and `muse skills list` exit stays 0). An
empty directory (no SKILL.md) is not even an error — it is ignored.
All 55 network-template skills staged into `.agents/skills` load
cleanly: 55/55 project rows over MSP, 81 CLI rows with zero
diagnostics and all `activation: on`.**

Rules table (each from `11-validate-<case>.json`):

| Fixture | `validate` | MSP `skill/list` | CLI `list` |
|---|---|---|---|
| `name: Bad Name!` | exit 1 `install-path-unsafe` | absent | top diag `invalid skill name` |
| missing `description` | exit 1 `must include description` | absent | top diag, same message |
| missing `name` | exit 0 valid | present as dir name | row, no diag |
| malformed YAML | exit 1 `install-path-unsafe: [unclosed…` | absent | top diag `invalid skill name \`[unclosed\`` |
| no frontmatter | exit 1 `must start with YAML frontmatter` | absent | top diag, same message |
| no SKILL.md | exit 1 `must contain SKILL.md` | absent | silently ignored |
| 262145 bytes | exit 1 `exceeds 262144 byte limit` | absent | top diag `skill-file-too-large` |
| `user-invocable: false` | exit 0 valid | absent (by design) | row, no diag |
| dir/name mismatch | exit 0 valid | frontmatter name wins | row under frontmatter name |

Command:

```sh
bun tools/msp-capture.ts session-probe --provider meta \
  --workspace $TMPD/ws-bad --muse-home $TMPD/muse-home \
  --muse-config-home $TMPD/muse-config --home $TMPD/fake-home \
  --serve-args="--trust-workspace" \
  --out out/wire-capture/skills-20261102T000830Z/03-validation-matrix.jsonl \
  --dump-skills out/wire-capture/skills-20261102T000830Z/03-validation-matrix-skills.json
```

Excerpt (`03-validation-matrix-skills.json`): 3 project rows of 10
fixtures — `frontmatter-name`, `missing-name`, `ok-control`. The 5
CLI diagnostics live in `09-cli-skills-list-bad.json`
(`diagnostics[0].message`: "skill file at …/bad-name/SKILL.md is
malformed: invalid skill name `Bad Name!`", scope `project`).

55-skill check (`02-net-55-skills.json`): `total: 69
{project: 55, bundled: 12, plugin: 2}`, staged − loaded = ∅ both
directions; CLI (`09-cli-skills-list-net55.json`): 81 rows, top
`diagnostics: []`, all `activation: on`.

## Implications for T100/K30

**Copy-into-workspace vs plugin vs user-level.** The evidence keeps
all three on the table but assigns them different jobs:

- Copy into `.agents/skills` (D40) stays the zero-step path: it is
  the only route that is workspace-scoped, trust-gated, live-reloaded
  (S4), and visible without any install step. Keep it for template
  skills and T100's package-level skills.
- A routeros-muse plugin is viable for *machine-level* distribution
  (bundle format + install + `pluginId` rows all proven), but it is
  NOT workspace delivery: installs are global, need a per-machine
  install/update step, ignore workspace trust, and `--scope project`
  showed no confinement in 1.4.14. Consider it only if T100 wants
  "install once, every workspace gets harness skills" semantics —
  and re-probe scope behavior on newer binaries first.
- User-level (`~/.agents/skills`, e.g. routeros-skills symlinks)
  suits the operator's own domain skills, but any same-name project
  skill silently shadows them (S3) — init should warn when a staged
  project name collides with a user skill the box already has.

**How to verify on session start (T100d).** `skill/list` alone can
prove presence/absence of *invocable* project skills by
`(selector, source)` — the committed `tools/skill-check.ts`
prototype does exactly this (missing/unexpected, exit 1 on drift).
But three gaps need the CLI full catalog alongside it: (1) broken
skills are silently absent from MSP — only `muse skills list --json`
diagnostics name them; (2) `user-invocable: false` project skills
never appear on MSP; (3) activation (`off`) hides rows in new
sessions with no MSP-visible trace. Recommendation: the session-start
check runs `skill/list` over MSP for the fast path plus a local
`muse skills list --json --workspace … --trust-workspace` (same
mechanism as the probes — no model cost) for diagnostics, and
compares frontmatter names, not directory names. Watch for the
setActivation staleness quirk: verify in a fresh session after any
activation write.

**How provenance/update could work.** muse gives T100 half the
primitives: `validate` returns per-file sha256 (`10-plugin-skill-
validate.json`), the plugin lockfile records `manifest_sha256` +
`package_sha256` + `installed_at` (`installed.json` shape captured
via the temp env), and activation records live per-workspace in
`settings.json`. But project skills (plain files) get no lockfile —
recording `(name, source, sha256)` at init time (T100a/b) remains
routeros-muse's job, e.g. a `skills.lock` beside `.agents/skills`
that `skill-check` (extended) diffs. Updates then mirror the plugin
flow: re-copy changed files (live, no reload per S4), surface the
diff, and never overwrite operator edits without the T100
never-overwrite rule. The deeper K30 redesign (one managed source)
should treat the plugin channel as the machine-level cache and the
workspace copy as the session-level truth — matching exactly how
muse itself layers plugin cache over project files.
