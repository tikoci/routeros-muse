# checks/ — prove it, every session

One command verifies captures on disk: manifest schema, sha256 + byte
size per listed file, `latest` resolution. No router contact — captures
on disk are the input. Runs first every session, after orienting.

## run

From the workspace root, with the checker recipe available:

```sh
bun checker.ts --device <device-id> --out observations   # one device
bun checker.ts --all --out observations                # every pulled device
```

One JSON line per device: `{device, ok, dir, totalBytes, files, problems}`.
Exit 0 clean, 1 problems. `_sample` must always pass — if it doesn't,
the tool is broken, not the network.

## verdicts

Append one line per run to `verdicts.md`: date, device, ok/problems,
totalBytes. A nonzero run is a finding (drift or incident input),
never rendered green, never fixed by hand-editing a pull.
