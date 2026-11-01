---
name: state-pull
description: "Capture a router into files: export-minus-secrets plus volatile-stripped JSON plus sha256 manifest, serial-gated. Use when: first look at any box, before/after a change, scheduled capture loops, drift questions, or capture-verify failures."
topics: [pull, manifest, redaction, drift]
tested: none
---

# `state-pull` skill (capture → manifest → verify → consume) [template v1 draft]

Promoted from the pull/checker prototype (VERIFIED on twin1 + bigdude:
full pulls ok, serial-refusal proven, checker clean; pull/README.md)
and the capture concepts (K4 the pull, K6 partial vocabulary, K3
record contracts, K8 drift-as-list). Backlog #25
(router-state-pull-with-manifest). Build-tracker references (T/K IDs,
notes paths) are pointers pending staging scrub. Device names are roles
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
  stabilized so diffs mean "config changed" (pull.ts:88-104).
- `<menu>.json` — resource, ip-address, interface, package
  (`/system/resource /ip/address /interface /system/package`,
  pull.ts:12) with volatile counters/timestamps stripped
  (pull.ts:106-119).
- `manifest.json` — target, serial, capture time, tool versions,
  sha256 + bytes per file, status ok/partial/refused, notes[]
  (checker.ts:22-55). Written LAST: a capture without a manifest is
  not a capture (K4; concepts.toml).
- Layout: `out/<device>/<timestamp>/` + `out/<device>/latest` symlink
  (pull/README.md). One writer per record class (K3): pull writes
  captures, nothing else touches them.

### 1. Pull (reads only — safe on production)

```sh
# twin path (no creds; curated --quickchr flag)
bun pull.ts --quickchr twin1 --out out
# host path (needs CENTRS_USERNAME/CENTRS_PASSWORD in env)
bun pull.ts --host <addr> --name <device> --out out
# Exit: 0 ok/partial, 2 refused (serial), 1 error
```

- Grounded: `make pull-twin` status ok, 5 files (export + 4 JSON +
  manifest); a real-router `make pull-host` status ok, 5 files, checker clean
  (pull/README.md; orca-setup.md:145-156, 186-190).
- Serial FIRST (identity gate): hardware reads
  `/system/routerboard serial-number`; CHR has no routerboard, so
  pull falls back to `/system/license system-id` (pull.ts:49-70).
  Single `--attributes X` projects `data` to the scalar, not an
  object (C4-shaped; pull.ts:56-64) — consumers parse accordingly.
- Export path: twin via `quickchr exec <twin> "/export terse"`
  (CRLF normalized before hashing — Q1, pull.ts:90-94); host via
  direct `/export terse` over native API as a READ, no `--yes`,
  text in `data.ret` (D1; pull.ts:96-104).
- Redaction is load-bearing: the first bigdude export leaked a live
  tunnel token via inline `/container/add env="..."` — the redactor
  now covers inline `env=` K/V plus `password|secret|private-key|
  community` (orca-setup.md:204-210; C1). Never store or post
  unredacted captures.

### 2. Verify (checker — no router contact)

```sh
bun checker.ts --device <device> --out out   # one device, JSON line report
bun checker.ts --all --out out               # every device
# Exit: 0 clean, 1 problems
```

- Grounded: checker clean on twin1 + bigdude captures; tampered
  fixture fails correctly (orca-setup.md:168-172).
- The checker verifies: manifest schema (target/serial/capturedAt/
  tools/files/notes), sha256 + bytes per file, `latest` symlink
  points at the newest ok/partial dir (checker.ts:79+).
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
  decision (K8; concepts.toml:70-76).
- Freshness triple (K6): `content_changed_at` vs `last_observed_at`
  vs `last_attempted_at` — healthy data never looks unobserved, and
  a failed re-pull never looks like fresh data.
- Views cite data + time (K3): every report names the capture
  timestamp it read. Intent and observation stay different records.

### 4. Refusal + partial (the honest states)

- Serial mismatch REFUSES: exit 2, `<timestamp>-refused/` dir with
  `attempt.json` only, `latest` untouched (pull.ts:78-86). Proven:
  tampered-manifest copy refused correctly (pull/README.md).
- Partial keeps last good: failed reads set `partial=true`, note the
  cause in `manifest.notes`, keep prior files (pull.ts:46-47,
  106-119). Vocabulary is ok/partial/refused/running (K6).
- Refusal or repeated partial on a scheduled loop is a notify event,
  not a silent skip — the look-after loop (T12) consumes these states.

## Part 2 — Skill doc

### Trigger

Load when: first look at any box (pull before anything else);
before/after a change (evidence pair); scheduled capture loops;
drift questions; checker failures; "what changed" questions of any
kind. (Entry-skill + capability-probe pattern: K22.)

### Prereqs

- Bun + centrs + quickchr on PATH (pull.ts shells to both).
- Twin path: machine running (`quickchr list`); host path: env creds
  mapped (`CENTRS_USERNAME`/`CENTRS_PASSWORD`) — the `.env` mapping
  is explicitly temporary (T9 designs the durable scheme).
- `first-contact` completed for the target (transport known, CDB
  record exists); for twins, `--quickchr` needs no creds.

### Access

- Pull is reads-only: safe on production (bigdude pull is status ok
  via native-API reads; orca-setup.md:186-190).
- Captures are LOCAL-ONLY: `out/` holds real network data (serials,
  addresses). Never commit captures; git-ignore on promotion
  (orca-setup.md:165-166).
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
  cited by timestamp (K23).

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
  CHR (C5); pull already falls back to license system-id.
- CRLF/hash skew → normalize `\r` before hashing (Q1; pull.ts:92).

### Limits

- Volatile-key list is a first guess; refine from real diffs over
  days (pull/README.md gap 2). Unexplained diff churn = strip-list
  work, not router signal.
- Redaction patterns are narrow by design; widen only with fixture
  proof (gap 3). A new secret shape in an export is a redactor bug
  to fix + anchor-test, not a shrug.
- The pull is a point-in-time capture, not monitoring: freshness
  comes from the scheduled loop (T12 look-after), not from pulling
  harder.
- CHR captures lack radios and hardware menus; note twin limits on
  every twin-sourced claim (K23).
