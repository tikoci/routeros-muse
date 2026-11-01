---
name: state-pull
description: "Capture a router into files: export-minus-secrets plus volatile-stripped JSON plus sha256 manifest, serial-gated. Use when: first look at any box, before/after a change, scheduled capture loops, drift questions, or capture-verify failures."
topics: [pull, manifest, redaction, drift]
tested: none
---

# `state-pull` skill (capture → manifest → verify → consume) [template v1 draft]

Promoted from the pull/checker prototype in the product repo
(VERIFIED on a CHR twin + production: full pulls ok,
serial-refusal proven, checker clean) and the capture concepts
(the pull, partial vocabulary, record contracts, drift-as-list).
Acquisition below is plain centrs, which ships on the package
PATH. Device names are roles (site-location-role), never serials
or addresses. No secrets below.

## Part 1 — The checklist (pull-first, verify, then read)

Run top to bottom. Every consumer (diff, drift list, report, change
proposal) reads from a VERIFIED capture, never live boxes.

1. Pull the box with centrs into a timestamped capture dir
   (serial-gated; export redacted, JSON volatile-stripped,
   manifest written LAST).
2. Verify the capture (schema, sha256 per file, `latest`
   symlink, totals) before consuming a single byte — by hand,
   or with the product repo's checker (optional extra, §2).
3. Consume from `latest/`: diff against the previous capture or the
   plan, file disagreements on the drift list, cite data + time.
4. On refusal or partial: serial mismatch refuses (attempt record
   only); partial keeps last-good files and says so in the manifest.

### 0. What a capture is

- `export.rsc` — `/export terse`, secrets redacted, header timestamp
  stabilized so diffs mean "config changed".
- `<menu>.json` — resource, ip-address, interface, package
  (`/system/resource /ip/address /interface /system/package`)
  with volatile counters/timestamps stripped.
- `manifest.json` — target, serial, capture time, tool versions,
  sha256 + bytes per file, status ok/partial/refused, notes[].
  Written LAST: a capture without a manifest is
  not a capture.
- Layout: `out/<device>/<timestamp>/` + `out/<device>/latest` symlink.
  One writer per record class: pull writes
  captures, nothing else touches them.

### 1. Pull (reads only — safe on production)

```sh
# identity gate FIRST (hardware serial; license system-id on CHR)
centrs retrieve --quickchr <twin> /system/routerboard --attributes serial-number
centrs retrieve --quickchr <twin> /system/license --attributes system-id
# export as a READ (no --yes): twin path, then host path
centrs execute --quickchr <twin> '/export terse' --timeout 30s
centrs execute --host <addr> --timeout 30s -- '/export terse'
# key prints, JSON for stable capture (host path: same commands with --host)
centrs retrieve --quickchr <twin> /system/resource --format json
centrs retrieve --quickchr <twin> /ip/address --format json
centrs retrieve --quickchr <twin> /interface --format json
centrs retrieve --quickchr <twin> /system/package --format json
```

- Commands above are help-verified (`centrs retrieve --help`,
  `centrs execute --help`): `--quickchr` needs no creds; the host
  path reads `CENTRS_USERNAME`/`CENTRS_PASSWORD` from env; `--yes`
  confirms write-shaped commands only, so reads never take it.
- Capture shape (export + 4 JSON + manifest) is VERIFIED via the
  product repo's `tools/pull` on a CHR twin + production (full
  pulls ok, serial-refusal proven, checker clean) — an optional
  extra for people working from a routeros-muse checkout (§2).
- Serial FIRST (identity gate): hardware reads
  `/system/routerboard serial-number`; CHR has no routerboard, so
  fall back to `/system/license system-id`.
  Single `--attributes X` projects `data` to the scalar, not an
  object — consumers parse accordingly.
- Export path: `/export terse` over centrs `execute` as a READ.
  Capture stdout to `export.rsc`, normalize CRLF before hashing.
- Redaction is load-bearing: the first production export leaked a live
  tunnel token via inline `/container/add env="..."` — the redactor
  now covers inline `env=` K/V plus `password|secret|private-key|
  community`. Never store or post
  unredacted captures.

### 2. Verify (no router contact)

- Verify by hand before consuming a single byte: recompute sha256 +
  bytes per file against `manifest.json`; confirm the manifest
  carries target/serial/capturedAt/tools/files/notes; confirm the
  `latest` symlink points at the newest ok/partial dir.
- Optional extra for people working from a routeros-muse checkout:
  `bun tools/pull/checker.ts --device <device> --out out` (one
  device, JSON line report) or `--all` (every device) automates
  the same checks — exit 0 clean, 1 problems. The checker does
  not ship in a scaffolded workspace; the hand-verify above is
  the baseline. Grounded: checker clean on twin + production
  captures; tampered fixture fails correctly.
- Consume NOTHING until the capture verifies.
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

- Serial mismatch REFUSES: write `<timestamp>-refused/` dir with
  `attempt.json` only, `latest` untouched. Proven:
  tampered-manifest copy refused correctly (the product checker
  reports this state as exit 2).
- Partial keeps last good: failed reads set `partial=true`, note the
  cause in `manifest.notes`, keep prior files.
  Vocabulary is ok/partial/refused/running.
- Refusal or repeated partial on a scheduled loop is a notify event,
  not a silent skip — the look-after loop consumes these states.

## Part 2 — Skill doc

### Trigger

Load when: first look at any box (pull before anything else);
before/after a change (evidence pair); scheduled capture loops;
drift questions; verify failures; "what changed" questions of any
kind. (Entry-skill + capability-probe pattern.)

### Prereqs

- centrs + quickchr on PATH (Bun only for the optional
  product-repo checker).
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
- One writer per record class: only the pull writes capture dirs;
  only a verify pass judges them.

### Envs

| Name | Use |
|---|---|
| `CENTRS_USERNAME` / `CENTRS_PASSWORD` | Host-path auth (no creds needed for `--quickchr`) |

Slow boxes: pass `--timeout 30s` (or higher) on retrieve/execute;
export reads on slow boxes can exceed defaults.

### Outputs

- `out/<device>/<timestamp>/`: export.rsc + 4 JSON + manifest.json.
- `out/<device>/latest` → newest ok/partial capture.
- Verify report per device: ok/problems, dir, totalBytes, files
  (the optional checker prints this as one JSON line).
- On refusal: `<timestamp>-refused/attempt.json` (reason recorded).

### Verification

- A verify pass (hand or checker) is clean on the capture before any consumption.
- `latest` resolves to the capture just pulled (post-pull).
- Manifest `files[]` sha256 + bytes match bytes on disk.
- Claim discipline: every claim carries command + output; captures
  cited by timestamp.

### Recovery

- sha256/bytes mismatch on verify → do not consume; re-pull; if the
  mismatch persists, the capture path (not the router) is suspect —
  investigate before trusting any capture from that run.
- Serial refusal → stop: the box is not the device's box (swapped
  hardware, wrong target, or spoofed identity). Escalate with the
  attempt.json; never force past a refusal.
- Export failed (partial) → manifest.notes names the cause; JSON
  menus still usable; retry export alone before treating as signal.
- `validation/unknown-path` on `/system/routerboard` → expected on
  CHR; fall back to license system-id.
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
