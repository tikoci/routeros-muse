---
name: acoustic-beep-calibration
description: "Calibrate the enbeep acoustic path before trusting a frame: fresh recordings on the real box with the real mic, analyzer suites as the gate, symbol-floor finding, and one calibration record per path. Use when: bringing up beep onboarding, re-measuring after any geometry change, or answering whether a beep path is demo-ready."
topics: [acoustic, measurement, onboarding]
tested: none
---

# `acoustic-beep-calibration` skill (question → record → gate → verdict → file)

enbeep is a `:beep` acoustic modem — a
router says its MAC/IP/state through its piezo and a
mic'd receiver decodes it. It is a cold-open beat and a
parlor trick, explicitly NEVER load-bearing
(handshake-only, analyzer-gated, never for provisioning,
monitoring, discovery, or anything operational). This
skill is the discipline that keeps it honest: no timing
choice without a fresh recording on the real hardware
with the real mic, no frame trusted past the analyzer,
one calibration record per path. No twin (CHR has no
beeper acoustics — the patched speaker test exercises
the encoder only, never the air path), no box writes
beyond approved beep runs.

Why fresh-everything: the corpus contradicts itself on
enbeep timing (HANDOFF flags say
50/100 ms ~100% at ~0 Hz offset; the README's hardware
findings say 200 ms floor at +100 Hz). Both died on
re-measurement — the +100 Hz claim failed on TWO boxes
(median offset −0.8 Hz over 16/16 tones on the RB1100AHx4). Build
on neither old claim: RE-MEASURE. That rule is this
skill's reason to exist.

Worked precedent (collected): a full production-router
campaign 2026-10-26 (mic path, room floor,
sweep, phase-1/2 frames, v2 Fletcher upgrade, gap
experiment). Analyzer suites re-run observed 2026-10-31:
legacy Python 18/18 OK, Bun decoder 94 pass / 1 skip /
0 fail across 5 files. No box contact for this skill's
promotion — the campaign stands as the grounding run.

## Part 1 — The checklist (measure the path you will film)

Run top to bottom. Geometry fixed until step 4 verdict;
any move restarts at step 1 with a NEW record.

1. State the question: which path must prove what
   (box + mic + geometry + receiver) (step 0).
2. Fresh recording: room floor, beeper sweep, then
   frames at the candidate symbol length (step 1).
3. Analyzer gate: suites green, frames decode,
   checksum decides, margins recorded (step 2).
4. Calibration verdict: symbol choice + floor + the
   limits this record does NOT cover (step 3).
5. File the record: campaign entry per path, old
   claims never reused (step 4).

### 0. Question (name the path or measure nothing)

- The unit of calibration is (beeper box, mic,
  geometry, symbol length, receiver). Change any
  one — new record. "The demo shot" is a geometry:
  mic position A (close, best-case) proves the
  codec; mic position B (~1 m, off-axis, realistic
  framing) proves the shot. Prove A first, then B.
- State what the path must carry: announce frame
  (MAC + IPv4 + state byte, checksum-gated) or text
  frame. Payload shape comes from the enbeep SPEC;
  this skill calibrates the AIR, not the format.
- Beep runs are box WRITES (sound the beeper via an
  approved run — production writes need explicit
  developer approval per item). Reads (MAC/IP
  ground truth) are read-only centrs retrieves.
- Campaign precedent: an RB1100AHx4 + USB
  mic, position A then owner-moved B; ground truth
  MAC/IP exact per run, CPU sampled pre-run (small
  drift expected and recorded as such).

### 1. Record (silence first, then sweep, then frames)

- Room floor: record silence at the fixed geometry
  first (precedent: RMS −64 dBFS stable ±0.4 dB,
  peak −46.6 dBFS, data band 1800–3700 Hz holding
  11% of ambient energy). A close-mic piezo tone
  should sit tens of dB above this — if it does
  not, fix the geometry before anything else.
- Sweep: 16 tones across the nibble band, nominal
  vs measured per tone (precedent: 16/16 within
  ±5 Hz, median −0.8 Hz; level varies with pitch —
  piezo resonance shape, decoder normalizes per
  window, no action). The sweep estimates pitch
  offset AND proves the mic hears every nibble.
- Frames at the candidate length, ×3 minimum for
  repeatability (precedent: 200 ms ×3 all exact,
  plus one faster probe to find the floor and one
  slower probe for margin). Zero router file writes
  — minified one-liner transport over SSH; globals
  removed after (precedent: environment count 0).
- Timing check rides free: section durations must
  match nominal at every speed (precedent: exact
  at 100/200/300 ms — killed the ":delay rounds"
  claim on this box too). Duration error is a
  box/timing finding, not noise.

### 2. Gate (the analyzer decides, not enthusiasm)

- Suites first: legacy Python analyzer 18/18 +
  Bun decoder suite green on the calibration host
  (observed 2026-10-31: 18/18 OK; 94 pass / 1 skip
  / 0 fail). A red suite stops the campaign — fix
  the tool before measuring the air.
- Decode every frame with the current decoder;
  record per-run verdict + bytes-vs-truth + offset
  + margins. Report format per run: ok/REJECT,
  bytes exact-or-which-field, per-tone max |df|,
  SNR. Precedent scoreboard shape: 5/7 exact, 1
  correct REJECT (fail-safe proven: sum tones
  decoded right, payload tone wrong, checksum
  caught it), 1 false-accept.
- The false-accept lesson (real 1/256-class event
  at 100 ms): corrupted bytes + a sum-tone error
  conspired to verify. Hardening, in order:
  byte-sum → Fletcher-16 checksum (v2, RouterOS-
  safe arithmetic); per-tone margin reject; symbol
  floor respected. Checksum verdict FIRST, byte
  comparison second.
- Failure-shape reading: quiet-after-loud tone
  errors (previous tone's ring-down wins the FFT)
  mean acoustic ISI, not a timing floor — slowing
  the symbol helps only until the room wins
  (precedent: 50 ms decay gap did NOT beat the
  room — last-25%-of-slot spectrum still driven).

### 3. Verdict (symbol choice + floor + limits)

- Symbol choice: the fastest length with N/N exact
  frames AND margin to the floor (precedent: 200 ms
  chosen — 4/4 exact across A/B geometries; 100 ms
  found the floor via ISI; 300 ms available as
  belt-and-braces at 1.5× airtime but buying
  little). Default 200 ms, slow path 400 ms per
  the enbeep README for slow beepers (~22 s).
- Floor statement: name the speed AND the mechanism
  ("100 ms fails by acoustic ISI: quiet tones after
  loud ones, section durations exact"). A floor
  without a mechanism is superstition.
- Limits, written down (precedent gaps that stay
  open until measured): sealed-case loudness,
  iPhone over-air (in-page self-test passed only),
  phone-mic + room variety (the measurement mic is best-case),
  other router models (two captured: RB1100AHx4 +
  RB953). The record covers its path and nothing
  else — say what it does NOT cover.
- No verdict without the record filled (the
  reference template: floor, sweep, frames table,
  verdict). A verdict in chat is a draft; the
  record is the verdict.

### 4. File (campaign entries, never reused claims)

- One calibration record per path (copy
  `references/calibration-record.md`): date,
  recordings archived with names, decoder version,
  ground-truth method, floor/sweep/frames/verdict.
  Recordings are evidence — keep the WAVs.
- Old records inform new campaigns (what to try
  first) but never SET parameters (symbol length,
  offset correction, margins always re-measured).
  The HANDOFF-vs-README contradiction is the
  standing warning: two confident stale claims,
  both wrong.
- Upstream linkage per `friction-reproduction-report`:
  tooling gotchas found mid-campaign file upstream
  (precedent: centrs SSH 10 s default silently kills
  a 12.4 s frame — `--timeout 30s`; not a router
  bug). Command + output in the record.
- Retire honestly: a path that never verifies (room
  too loud, beeper too quiet, geometry impossible)
  gets a record saying so — "not demo-ready" is a
  complete verdict, not a failure to file.

## Part 2 — Skill doc

### Trigger

Load when: bringing up beep onboarding on a new box
or geometry; re-measuring after any move; choosing a
symbol length; reviewing an enbeep decoder change;
or asking "is this beep path demo-ready".

### Prereqs

- This doc's worked precedent read (precedent values
  are starting points, never parameters).
- enbeep checkout with both suites runnable (legacy
  Python venv + Bun); a mic path verified with
  `arecord` (or platform equivalent) before any
  beep run.
- Approved beep-run authority for the target box
  (writes-gated per item); read-only ground-truth
  access (MAC/IP/state reads).
- This skill's reference record template.

### Access

- Suite runs + silence recordings: safe anywhere.
  Beep runs SOUND the box — scheduled, approved,
  time-boxed (~70 s beeping ≈ 5 min wall for a
  phase-1 matrix in precedent).
- No config writes, no file writes on the box
  (one-liner transport; environment left clean).
  Twin use is encoder-only (dry-run cross-checks);
  the air path needs the real box + real mic.

### Envs

- `CENTRS_TIMEOUT`: raise past the longest frame
  (precedent: 30 s for a ~12 s frame) — the 10 s
  default kills frames mid-payload silently.
- No secrets: MAC/IP travel audibly by design and
  are private-range in campaigns; records cite verdicts
  (exact/wrong-field), not values.

### Outputs

- Calibration record per path (floor, sweep,
  frames table, verdict, limits).
- Archived recordings + decoder versions.
- Symbol choice + floor + mechanism statement.
- Filed tooling gotchas (if any) with transcripts.

### Verification

- Both analyzer suites green on the cal host.
- Sweep 16/16 within tolerance with offset stated.
- Frames table complete: every run has a verdict,
  byte comparison, and margins — no silent drops.
- Verdict names symbol choice, floor mechanism,
  and what the record does NOT cover.
- Box left clean (no files, no globals); beep
  time inside the approved window.

### Recovery

- Suite red → stop the campaign, fix the tool.
- Sweep misses tones → geometry/mic first (closer,
  quieter, on-axis); offset correction is a
  decoder concern, not a substitute for signal.
- Frames REJECT at all lengths → check ground
  truth freshness (stale CPU reads drift), then
  slow down, then question the room.
- False-accept (bytes wrong, checksum passed) →
  stop, harden the checksum/margins, re-run the
  whole matrix — one event invalidates the gate.

### Limits

- Cold-open beat only: handshake, analyzer-gated,
  never load-bearing. Any proposal to DEPEND on
  beeps (provisioning, monitoring, discovery)
  fails this skill's verification.
- Humans hear it: every run is audible by design —
  schedule accordingly, and never beep a box
  whose owner has not agreed.
- This skill calibrates air paths; it does not
  design frames (enbeep SPEC), write decoders
  (enbeep repo), or approve beep runs (owner).
- Two models captured, phones unproven over-air,
  rooms vary: every new path measures, no
  exceptions, no matter how similar it looks.
