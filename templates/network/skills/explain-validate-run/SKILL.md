---
name: explain-validate-run
description: "Ground every RouterOS command before it runs: rosetta docs, offline explain, live device validation, disposable-CHR proof, two-endpoint read-back. Use when: running an unfamiliar command, proving a procedure before production, or teaching the loop to a new session."
topics: [explain, validate, rosetta, testing]
requires: [twin]
tested: none
---

# `explain-validate-run` skill (docs → explain → validate → run → check) [template v1 draft]

Promoted from the executed loop proof (t28-evr-proof.md: note write
through all five rungs on twin-evr) plus the T6 `numbers=` precedent
and the /console/inspect probe mechanics. Backlog #28. No secrets
below; validation outputs carry no credentials.

## Part 1 — The checklist (each rung catches what the last can't)

Run top to bottom. Skipping a rung is allowed only by naming which
one and why, in the ledger.

1. Read the docs (§0): rosetta lookup for the command's meaning,
   with DB identity cited.
2. Explain offline (§1): `centrs explain` with no router — shape,
   write-bit, and API mapping for free.
3. Validate live (§2): `centrs explain` against the twin — :parse
   + highlight + child + syntax from the real parser.
4. Run on the disposable twin (§3): `--yes` write, transport
   auto-selected, validation never disabled.
5. Two-endpoint read-back (§4): same object over REST AND native
   API — agreement is the proof.

### 0. Docs (rosetta first, version-cited)

```
$ ROSETTA_OFFLINE=1 rosetta browse --once search "/system/note set"
rosetta v0.11.3 ready (DB schema v11, 370 pages, release v0.11.3).
8 of 8 page results · classified: path=/system/note topics=[system] verbs=[set]
1 Note · docs > system-information-and-utilities/note · 468w
  https://manual.mikrotik.com/docs/system-information-and-utilities/note
```

- Ranked hits with manual URLs, offline-capable (`ROSETTA_OFFLINE=1`
  skips freshness checks). This rung answers "what does it mean",
  never "will it run".
- Cite DB identity on every rosetta-backed claim (release + schema
  + version range). The twin runs 7.26beta3; the DB range ends at
  7.25rc1 — past the edge, docs are advisory and the live device
  wins (silent-fallback trap, orca-setup).
- Docs disagreeing with the device is data: record both, trust the
  device for ITS behavior, file the doc gap upstream if it matters.

### 1. Explain offline (free, necessary, insufficient)

```
$ centrs explain '/system/note/set note=t28-evr-proof'
verdict: pass · write-shaped · runtimeAcceptance: not-proven

$ centrs explain '/system/script/run numbers=t28x'
verdict: pass · runtimeAcceptance: not-proven   ← ALSO passes
```

- Offline explain canonicalizes the input, reports structure +
  syntax diagnostics, and shows the centrs call it would become
  (`api … -X POST -f …`). No connection, no credentials, instant.
- It passes the known-bad `numbers=` form (T6 finding 1: RouterOS
  rejects it at runtime with "bad parameter numbers"). The envelope
  says `runtimeAcceptance: not-proven` itself — believe it. Offline
  pass is necessary, never sufficient.
- First thing to run when a command is REJECTED, too: if offline
  passes, the problem is the device, not the string — re-quoting
  cannot help (centrs#361; failure-layer-attribution §1).

### 2. Validate live (the device's own parser)

```
$ centrs explain --quickchr twin-evr '/system/note/set note=t28-evr-proof'
verdict: pass
live: 7.26beta3 x86_64 · parse accepted · highlight 35 byte(s) · arguments 1 path(s), 3 name(s)
evidence: live0 /system/resource, live1 :parse, live2 highlight, live3 child, live4 syntax
runtimeAcceptance: not-proven

$ centrs explain --quickchr twin-evr '/system/script/run numbers=t28x'
verdict: fail — 1 diagnostic(s)
live: 7.26beta3 x86_64 · parse rejected at 1:32 · ...
```

- Live validation runs `:parse` + `highlight` + `child` + `syntax`
  on the target (the /console/inspect surface): version-exact,
  package-exact, state-exact. It catches what offline misses —
  the bad form fails here at 1:32.
- Read-only and safe on any box (reads need no approval): run it
  against production hardware too when firmware differs from the
  twin. Probe results are stateful — record version + packages
  with every verdict.
- Residual gap (measured, inspect skill): inspect-vs-runtime cases
  exist (`blackhole=yes` passes inspect, runtime wants bare
  `blackhole`). Live validation is necessary, still not
  sufficient. Only execution proves runtime acceptance.

### 3. Run (disposable CHR proves it)

```
$ centrs execute --quickchr twin-evr --yes '/system/note/set note=t28-evr-proof' --json
ok: True data: {} via: native-api
```

- One RouterOS statement per call; writes refuse without `--yes`
  outside a TTY. Transport auto-selects (native-api here) — the
  `via` names what carried it.
- Never disable validation to make a write succeed (`--no-validate`
  is a deliberate, explained choice, not a workaround): validation
  is the product. A write that only passes with validation off is
  a write you don't understand yet.
- Twin first, always (twin-ops): the twin run IS the proof for
  table-shape claims. Production runs follow change-apply (twin
  proof + proposal + deadman + same read-backs), never solo.

### 4. Two-endpoint check (agreement is the proof)

```
$ centrs retrieve --quickchr twin-evr --via rest-api /system/note --json
note: t28-evr-proof
$ centrs retrieve --quickchr twin-evr --via native-api /system/note --json
note: t28-evr-proof
MATCH: two endpoints agree
```

- Same object, two transports, identical value. The first read-back
  proves the write path; the second proves the STATE — it catches
  transport-specific rendering lies and stale reads that a single
  read-back can't.
- `--json` always (default text drops warnings/tips/meta). Take row
  counts from `meta.operation.objectCount`, not from `data` shape
  (empty-object/single-object/array instability, centrs#360).
- Cleanup is part of the loop: clear the test value, read back the
  cleared state, tear down the twin (t28-evr-proof.md §6). A proof
  that leaves residue is half a proof.

## Part 2 — Skill doc

### Trigger

Load when: running any unfamiliar RouterOS command; proving a
procedure before production; onboarding ("how do I safely try
things here"); "will this command work" questions; a rejection
needs diagnosis (explain-first). (Entry-skill +
capability-probe pattern: K22.)

### Prereqs

- rosetta warmed (`rosetta --setup` once; DB present) for the docs
  rung; offline flag for hermetic runs.
- centrs + quickchr on PATH; a twin at the target firmware for
  rungs 2–4 (live validation + proof).
- The command written down before rung 1 — the loop validates a
  candidate, it doesn't invent one.

### Access

- Rungs 0–2 are read-only: safe on twins AND production (bigdude
  reads free). Live validation opens no write path.
- Rung 3 writes: twin freely; production only behind change-apply
  (approval + deadman). Rung 4 reads back wherever rung 3 wrote.
- No credentials in the ledger for any rung (evidence-ledger);
  validation outputs are credential-free by construction.

### Envs

| Name | Use |
|---|---|
| `ROSETTA_OFFLINE=1` | Skip DB freshness network checks |
| `CENTRS_TIMEOUT` | Raise for slow-twin validation + reads |

### Outputs

- Docs hit (page + URL + DB identity) for the command.
- Offline verdict + live verdict with the `live:` line quoted.
- Twin execution record (command, `via`, result).
- Two-endpoint read-back (both values + MATCH/MISMATCH).
- Ledger entry tying all five rungs to the question.

### Verification

- Every rung ran or is explicitly skipped-with-reason in the
  ledger. "Validated" without a quoted `live:` line is unproven.
- Two endpoints agree on a non-empty value (empty MATCH on an
  empty expectation is stated, not assumed).
- Cleanup read-back shows the cleared state; twin torn down or
  restored to prior state.
- Version skew noted wherever firmware and DB range differ.

### Recovery

- Offline/explain disagree with the device: device wins for its
  behavior; record both (docs rung rule).
- `validation/syntax` on a well-formed command: missing menu
  (package/device-mode), not bad quoting — check
  `/system/package`, don't re-quote (centrs#361).
- Endpoints disagree: stop — re-read both (stale read?), then
  suspect transport rendering; do NOT proceed to production on a
  MISMATCH.
- Twin unavailable (no KVM, no cache, no network): say so
  honestly — downgrade to explain-only with runtimeAcceptance
  pending, never upgrade by assumption.

### Limits

- CHR proof only (7.26beta3 here): firmware-specific rows need
  per-firmware twins; radio/hardware behavior never proven here.
- Rosetta range-bounded (7.1.1–7.25rc1 at v0.11.3): past the edge
  is advisory-only, always cited.
- Inspect-vs-runtime gap acknowledged, unprobed in our runs: a
  live-validated command can still fail at execution — rung 3 is
  what closes that, not rung 2.
- The loop validates commands, not designs: a perfectly valid
  command can still be the wrong change (adversarial review,
  backlog #33, is the separate control).
