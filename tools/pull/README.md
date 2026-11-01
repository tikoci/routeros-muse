# pull (prototype, Track A)

One command captures one router into files:

- `export.rsc` — `/export terse`, secrets redacted, header timestamp stabilized
  (twin path only for now; see below)
- `<menu>.json` — resource, ip-address, interface, package with volatile
  counters/timestamps stripped so diffs mean "config changed"
- `manifest.json` — target, serial, capture time, tool versions, sha256 per file

Serial gate: a capture whose serial differs from the slot's last manifest is
refused (exit 2, `attempt.json` only, nothing published). Partial failures
keep the last good files and say so in `manifest.notes`.

Layout: `out/<slot>/<timestamp>/` + `out/<slot>/latest` symlink.

## Run

```sh
make test          # anchor tests
make pull-twin     # full pull of twin1 (export + JSON)
make pull-bigdude  # JSON-shape pull of bigdude (export skipped, see gap)
```

`pull-bigdude` maps `~/.env` (`ROUTEROS_*`) to `CENTRS_*`. That mapping is
explicitly temporary — the durable credential scheme is a later decision.

## Known gaps

1. `--host` export rides D1 (direct `/export terse` over native API as a read).
   Fallbacks if that ever fails: SSH key (installed 2026-10-26, see notes) or
   staged-script-run (approved, unused).
2. Volatile-key list is a first guess; refine from real diffs over days.
3. Redaction patterns are narrow by design; widen only with fixture proof.
