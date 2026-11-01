---
name: state-pull
description: "Capture a router into files: export-minus-secrets plus volatile-stripped JSON plus sha256 manifest, serial-gated. Use when: first look at any box, before/after a change, scheduled capture loops, drift questions, or capture-verify failures."
topics: [pull, manifest, redaction, drift]
tested: none
---

# `state-pull` skill (capture → manifest → verify → consume) [template v1 draft]

Promoted from the pull/checker prototype (VERIFIED on a CHR twin +
production: full pulls ok, serial-refusal proven, checker clean)
and the capture concepts (the pull, partial vocabulary,
record contracts, drift-as-list). Device names are roles
(site-location-role), never serials or addresses. No secrets below.

## Part 1 — The checklist (pull-first, verify, then read)

Run top to bottom. Every consumer (diff, drift list, report, change
proposal) reads from a VERIFIED capture, never live boxes.

1. Pull the box into a timestamped capture dir (serial-gated; export
   redacted, JSON volatile-stripped, manifest written LAST).
2. Verify the capture with the checker (schema, sha256 per file,
   `latest` symlink, totals) before consuming a single byte.
3. Consume from `latest/`: diff against the previous capture or the
   plan, file disagreements on the drift list, cite data + time.
4. On refusal or partial: serial mismatch refuses (exit 2, attempt
   only); partial keeps last-good files and says so in the manifest.

### 0. What a capture is

- `export.rsc` — `/export terse`, secrets redacted, header timestamp
  stabilized so diffs mean "config changed".
- `<menu>.json` — resource, ip-address, interface, package
  (`/system/resource /ip/address /interface /system/package`)
  with volatile counters/timestamps stripped.
- `manifest.json` — target, serial, capture time, tool versions,
  sha256 + bytes per file, status ok/partial/refused, notes[]
  (checker.ts). Written LAST: a capture without a manifest is
  not a capture.
- Layout: `out/<device>/<timestamp>/` + `out/<device>/latest` symlink.
  One writer per record class: pull writes
  captures, nothing else touches them.

### 1. Pull (reads only — safe on production)

```sh
# twin path (no creds; curated --quickchr flag)
bun pull.ts --quickchr <twin> --out out
# host path (needs CENTRS_USERNAME/CENTRS_PASSWORD in env)
bun pull.ts --host <addr> --name <device> --out out
# Exit: 0 ok/partial, 2 refused (serial), 1 error
```

- Grounded: `make pull-twin` status ok, 5 files (export + 4 JSON +
  manifest); a real-router `make pull-host` status ok, 5 files, checker clean.
- Serial FIRST (identity gate): hardware reads
  `/system/routerboard serial-number`; CHR has no routerboard, so
  pull falls back to `/system/license system-id`.
  Single `--attributes X` projects `data` to the scalar, not an
  object — consumers parse accordingly.
- Export path: twin via `quickchr exec <twin> "/export terse"`
  (CRLF normalized before hashing); host via
  direct `/export terse` over native API as a READ, no `--yes`,
  text in `data.ret`.
- Redaction is load-bearing: the first production export leaked a live
  tunnel token via inline `/container/add env="..."` — the redactor
  now covers inline `env=` K/V plus `password|secret|private-key|
  community`. Never store or post
  unredacted captures.

### 2. Verify (checker — no router contact)

```sh
bun checker.ts --device <device> --out out   # one device, JSON line report
bun checker.ts --all --out out               # every device
# Exit: 0 clean, 1 problems
```

- Grounded: checker clean on twin + production captures; tampered
  fixture fails correctly.
- The checker verifies: manifest schema (target/serial/capturedAt/
  tools/files/notes), sha256 + bytes per file, `latest` symlink
  points at the newest ok/partial dir (checker.ts).
- Consume NOTHING until the checker is clean on that capture.
  Hash-verify is the price of admission for diffs, drift lists,
  and reports.

### 3. Consume (diff, drift, cite)

- Diff `latest/` against the previous capture (what changed on the
  box) or against the plan TOML (drift?). Volatile-stripped JSON
  means diffs are config signal, not counter noise.
- Drift goes on a LIST: plan (human/agent-written) vs captures
  (pull-written) disagreement lands on the drift list or the router
  gets fixed — never rewrite the plan to match unless that IS the
  decision.
- Freshness triple: `content_changed_at` vs `last_observed_at`
  vs `last_attempted_at` — healthy data never looks unobserved, and
  a failed re-pull never looks like fresh data.
- Views cite data + time: every report names the capture
  timestamp it read. Intent and observation stay different records.

### 4. Refusal + partial (the honest states)

- Serial mismatch REFUSES: exit 2, `<timestamp>-refused/` dir with
  `attempt.json` only, `latest` untouched. Proven:
  tampered-manifest copy refused correctly.
- Partial keeps last good: failed reads set `partial=true`, note the
  cause in `manifest.notes`, keep prior files.
  Vocabulary is ok/partial/refused/running.
- Refusal or repeated partial on a scheduled loop is a notify event,
  not a silent skip — the look-after loop consumes these states.

## Part 2 — Skill doc

### Trigger

Load when: first look at any box (pull before anything else);
before/after a change (evidence pair); scheduled capture loops;
drift questions; checker failures; "what changed" questions of any
kind. (Entry-skill + capability-probe pattern.)

### Prereqs

- Bun + centrs + quickchr on PATH (pull.ts shells to both).
- Twin path: machine running (`quickchr list`); host path: env creds
  mapped (`CENTRS_USERNAME`/`CENTRS_PASSWORD`) — the `.env` mapping
  is explicitly temporary.
- `first-contact` completed for the target (transport known, CDB
  record exists); for twins, `--quickchr` needs no creds.

### Access

- Pull is reads-only: safe on production (production pull is status ok
  via native-API reads).
- Captures are LOCAL-ONLY: `out/` holds real network data (serials,
  addresses). Never commit captures; git-ignore on promotion.
- One writer per record class: only pull writes capture dirs; only
  the checker judges them.

### Envs

| Name | Use |
|---|---|
| `CENTRS_USERNAME` / `CENTRS_PASSWORD` | Host-path auth (no creds needed for `--quickchr`) |
| `CENTRS_TIMEOUT` | Raise for slow boxes; export reads can exceed 10s |

### Outputs

- `out/<device>/<timestamp>/`: export.rsc + 4 JSON + manifest.json.
- `out/<device>/latest` → newest ok/partial capture.
- Checker JSON line per device: ok/problems, dir, totalBytes, files.
- On refusal: `<timestamp>-refused/attempt.json` (reason recorded).

### Verification

- Checker exit 0 on the capture before any consumption.
- `latest` resolves to the capture just pulled (post-pull).
- Manifest `files[]` sha256 + bytes match bytes on disk.
- Claim discipline: every claim carries command + output; captures
  cited by timestamp.

### Recovery

- Checker sha256/bytes mismatch → do not consume; re-pull; if the
  mismatch persists, the capture path (not the router) is suspect —
  investigate before trusting any capture from that run.
- Serial refusal → stop: the box is not the device's box (swapped
  hardware, wrong target, or spoofed identity). Escalate with the
  attempt.json; never force past a refusal.
- Export failed (partial) → manifest.notes names the cause; JSON
  menus still usable; retry export alone before treating as signal.
- `validation/unknown-path` on `/system/routerboard` → expected on
  CHR; pull already falls back to license system-id.
- CRLF/hash skew → normalize `\r` before hashing.

### Limits

- Volatile-key list is a first guess; refine from real diffs over
  days (a known gap). Unexplained diff churn = strip-list
  work, not router signal.
- Redaction patterns are narrow by design; widen only with fixture
  proof. A new secret shape in an export is a redactor bug
  to fix + anchor-test, not a shrug.
- The pull is a point-in-time capture, not monitoring: freshness
  comes from the scheduled loop, not from pulling
  harder.
- CHR captures lack radios and hardware menus; note twin limits on
  every twin-sourced claim.
