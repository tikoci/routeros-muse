# observations/ — what the network IS (dated pulls)

Each pull lands under `observations/<device>/pull-<timestamp>/` with a
`manifest.json` (target, serial, time, tool versions, sha256 per file)
and `latest` repointed at it. Raw pull dirs are LOCAL-ONLY (git-ignored);
what commits is the redacted sibling `summary.md`.

## freshness (three clocks, never one)

- `content_changed_at` — the pull's bytes differ from the last good pull.
- `last_observed_at` — the last pull that actually read the box.
- `last_attempted_at` — the last try, success or failure.

A quiet box with fresh pulls is healthy, not stale. A failed pull is a
finding, and last-good files stay until a better pull replaces them.

## summary.md contract (commits)

Device, the three clocks, file list + sizes + statuses, checker verdict —
no serials, no secrets. The summary is the pointer to where more detail
lives (the local raw pull). Sample below; replace on first pull.

```md
# summary — demo-office-gw (SAMPLE)

- content_changed_at: SAMPLE (no pull yet)
- last_observed_at: SAMPLE (no pull yet)
- last_attempted_at: SAMPLE (no pull yet)
- files: none yet (first pull lands pull-<timestamp>/ + manifest.json)
- checker: not run yet (see checks/)
```

## _sample/ — committed self-test fixture

`_sample/` holds synthetic capture data (fake serial, fake bytes,
clearly labeled) with a valid manifest, so `checker --all` proves the
tool works on a fresh clone. It is the ONLY committed pull-shaped dir.
Real devices follow the same shape under ignored `pull-*/` dirs.
