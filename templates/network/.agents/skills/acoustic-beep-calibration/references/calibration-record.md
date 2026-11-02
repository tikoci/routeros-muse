# Calibration record template (copy per path, fill from the run)

One record per (beeper box, mic, geometry, symbol length).
A new box, a moved mic, or a new room starts a NEW record —
old numbers never transfer. File next to the recordings.

```markdown
# Calibration: <box-model> + <mic> @ <geometry>, <sym> symbols

Date: YYYY-MM-DD. Recordings: <paths>. Decoder: <tool + version>.
Ground truth: <how MAC/IP/state were read, read-only>.

## Room floor (silence, mic fixed)

- RMS dBFS: ..., peak dBFS: ...
- Data-band share of ambient energy: ...

## Sweep (16 tones, nominal vs measured)

- Tones within ±5 Hz: n/16. Median offset Hz: ...
- Level spread dB (low vs high nibbles): ...

## Frames (announce, checksum-gated)

| Run | Sym | Verdict | Bytes | Notes |
| ... | ... | ok / REJECT | exact / wrong(field) | ... |

## Verdict

- Symbol choice: ... (floor found at ...: timing | acoustic-ISI | room).
- Margins: per-tone |df| max ..., SNR dB ....
- Limits: <geometry, room, receiver — what this record does NOT cover>.
```

Rules: checksum verdict first, byte comparison second (a
false-accept is a 1/256-class event — the campaign caught
one live). Per-tone |df| vs assigned center is diagnostic
only (round() bounds it); the checksum is the protection.
