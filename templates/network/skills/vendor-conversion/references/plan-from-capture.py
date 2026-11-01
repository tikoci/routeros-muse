#!/usr/bin/env python3
"""plan-from-capture.py — vendor-conversion reference planner (stdlib only).

Reads an old-setup capture (see fixtures/old-site-ubnt.json), validates the
schema, and emits a migration plan where EVERY step carries exactly one
provenance marker: <- capture:<json-path>, <- absence:<fact>, or
<- lazy:<field> (confirm before migrate). Fields containing "(owner-stated,
unverified)" or "(owner-stated)" become lazy lines.

Usage: plan-from-capture.py [capture.json]   (default: fixtures/old-site-ubnt.json)
Exit: 0 plan on stdout; 2 schema violation on stderr.
"""
import json
import os
import sys

REQUIRED_TOP = ["synthetic", "site", "old_vendor", "devices", "ssids", "subnets", "absences"]
LAZY_MARKERS = ("(owner-stated, unverified)", "(owner-stated)")


def fail(msg):
    print(f"schema violation: {msg}", file=sys.stderr)
    return 2


def is_lazy(value):
    return isinstance(value, str) and any(m in value for m in LAZY_MARKERS)


def main():
    default = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "old-site-ubnt.json")
    path = os.environ.get("CAPTURE_JSON", sys.argv[1] if len(sys.argv) > 1 else default)
    try:
        with open(path, encoding="utf-8") as fh:
            cap = json.load(fh)
    except (OSError, ValueError) as exc:
        return fail(f"cannot load {path}: {exc}")
    if not isinstance(cap, dict):
        return fail("top level must be an object")
    for key in REQUIRED_TOP:
        if key not in cap:
            return fail(f"missing required key {key!r}")
    for key in ("devices", "ssids", "subnets", "absences"):
        if not isinstance(cap[key], list):
            return fail(f"{key!r} must be a list")
    if not cap["absences"]:
        return fail("absences must be non-empty (an empty list means the surveyor skipped the question)")

    steps = []
    lazy_count = 0

    def emit(text, provenance, lazy=False):
        steps.append((text, provenance, lazy))

    for i, dev in enumerate(cap["devices"]):
        if not isinstance(dev, dict) or "role" not in dev:
            return fail(f"devices[{i}] must be an object with a role")
        blob = json.dumps(dev, sort_keys=True)
        if is_lazy(blob):
            emit(f"Migrate {dev['role']} ({dev.get('vendor_model', '?')}) after confirming stated uplink/state",
                 f"<- lazy:devices[{i}] (confirm before migrate)", True)
        else:
            emit(f"Migrate {dev['role']} ({dev.get('vendor_model', '?')}) per capture",
                 f"<- capture:devices[{i}]")
    for i, ssid in enumerate(cap["ssids"]):
        if not isinstance(ssid, dict) or "name" not in ssid or "auth" not in ssid:
            return fail(f"ssids[{i}] must be an object with name + auth")
        emit(f"Rebuild SSID {ssid['name']} auth={ssid['auth']} vlan={ssid.get('vlan')}",
             f"<- capture:ssids[{i}]")
    for i, subnet in enumerate(cap["subnets"]):
        if not isinstance(subnet, dict) or "cidr" not in subnet:
            return fail(f"subnets[{i}] must be an object with cidr")
        emit(f"Rebuild subnet {subnet['cidr']} dhcp={subnet.get('dhcp')} dns={subnet.get('dns')}",
             f"<- capture:subnets[{i}]")
    for absence in cap["absences"]:
        emit(f"Close absence: {absence}", f"<- absence:{absence}")
    for complaint in cap.get("complaints", []):
        if is_lazy(complaint):
            emit(f"Investigate complaint: {complaint}", "<- lazy:complaints (confirm before migrate)", True)

    lazy_count = sum(1 for _, _, lazy in steps if lazy)
    synth = "SYNTHETIC EXAMPLE" if cap.get("synthetic") is True else "REAL-SITE CAPTURE"
    print(f"# Migration plan for {cap['site']} ({cap['old_vendor']} -> mikrotik) [{synth}]")
    print(f"# lazy count: {lazy_count} (zero required before any cutover phase schedules)")
    for text, provenance, _ in steps:
        print(f"- STEP {text} {provenance}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
