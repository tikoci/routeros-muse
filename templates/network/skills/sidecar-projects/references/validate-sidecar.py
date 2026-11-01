#!/usr/bin/env python3
"""validate-sidecar.py — check a sidecar manifest before it counts as known.

A sidecar is a directory sibling of the managed network: its own build,
known to the network's records, integrable later. The manifest
(<dir>/sidecar.toml) is the "known to records" half made mechanical.
Schema v1 is PROPOSED (see SKILL.md Limits) — the validator enforces the
proposal exactly so the first real sidecar ratifies or amends one thing.

Usage: validate-sidecar.py <sidecar-dir>   (expects sidecar.toml inside)
Exit 0 = known-good; non-zero prints FAIL <id> lines. Stdlib only.
"""
import sys
import tomllib
from pathlib import Path

STATUSES = {"spike", "active", "integrated", "retired"}
SURFACES = {"none", "files", "api", "network"}


def main(d):
    fails = []
    d = Path(d)
    mf = d / "sidecar.toml"
    try:
        m = tomllib.loads(mf.read_text())
    except (OSError, tomllib.TOMLDecodeError) as e:
        print(f"FAIL S0: cannot read sidecar.toml: {e}")
        return 2
    for f in ("name", "problem", "rejected_alternative", "records_link", "status"):
        if not str(m.get(f, "")).strip():
            fails.append(f"FAIL S1: manifest needs non-empty {f}")
    if m.get("name") != d.name:
        fails.append(f"FAIL S2: name {m.get('name')!r} must match directory {d.name!r}")
    if m.get("status") not in STATUSES:
        fails.append(f"FAIL S3: status must be one of {sorted(STATUSES)}")
    surf = m.get("integration_surface", "none")
    if surf not in SURFACES:
        fails.append(f"FAIL S4: integration_surface must be one of {sorted(SURFACES)}")
    elif surf != "none" and not str(m.get("integration_detail", "")).strip():
        fails.append("FAIL S4: non-none integration_surface needs integration_detail")
    if m.get("status") == "integrated" and surf == "none":
        fails.append("FAIL S4: status integrated contradicts integration_surface none")
    why = str(m.get("rejected_alternative", ""))
    if why.strip() and len(why.strip()) < 20:
        fails.append("FAIL S5: rejected_alternative must say WHY (min 20 chars, "
                     "not just a product name)")
    if m.get("status") == "retired" and not str(m.get("retired_note", "")).strip():
        fails.append("FAIL S6: status retired needs retired_note (what replaced it)")
    for f in fails:
        print(f)
    if fails:
        return 1
    print(f"ok: sidecar {m['name']} known ({m['status']}, via {m['records_link']})")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: validate-sidecar.py <sidecar-dir>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
