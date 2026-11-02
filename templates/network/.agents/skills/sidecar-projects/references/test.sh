#!/bin/sh
# test.sh — sidecar-projects self-test (offline): validate-sidecar.py
# accepts the parable-shaped fixture dir and rejects the four broken
# manifests, each naming its rule. Needs: sh, python3 (3.11+ tomllib).
set -eu
refs=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
command -v python3 >/dev/null 2>&1 || { echo "FAIL: missing python3"; exit 1; }
fail=0
if out=$(python3 "$refs/validate-sidecar.py" "$refs/fixtures/solar-monitor" 2>&1); then
  echo "ok accept: solar-monitor ($out)"
else echo "FAIL accept: solar-monitor rejected: $out"; fail=1; fi
reject() { # reject <dir> <rule>
  if out=$(python3 "$refs/validate-sidecar.py" "$refs/fixtures/$1" 2>&1); then
    echo "FAIL reject: $1 accepted (want $2)"; fail=1
  elif printf '%s' "$out" | grep -q "FAIL $2"; then
    echo "ok reject: $1 names $2"
  else echo "FAIL reject: $1 missed $2: $out"; fail=1; fi
}
reject bad-missing-link S1
reject bad-name S2
reject bad-status S3
reject bad-no-why S5
exit $fail
