#!/bin/sh
# test.sh — netinstall-flash self-test (offline): validate-plan.py accepts
# the two good fixtures (cli run + package-flow server entry) and rejects
# the five broken ones, each naming its rule. Needs: sh, python3.
set -eu
refs=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
command -v python3 >/dev/null 2>&1 || { echo "FAIL: missing python3"; exit 1; }
fail=0
pass() { # pass <fixture>
  if out=$(python3 "$refs/validate-plan.py" "$refs/fixtures/$1" 2>&1); then
    echo "ok accept: $1 ($out)"
  else echo "FAIL accept: $1 rejected: $out"; fail=1; fi
}
reject() { # reject <fixture> <rule>
  if out=$(python3 "$refs/validate-plan.py" "$refs/fixtures/$1" 2>&1); then
    echo "FAIL reject: $1 accepted (want $2)"; fail=1
  elif printf '%s' "$out" | grep -q "FAIL $2"; then
    echo "ok reject: $1 names $2"
  else echo "FAIL reject: $1 missed $2: $out"; fail=1; fi
}
pass good-cli.json
pass good-server.json
reject bad-system-not-first.json R1
reject bad-devmode-in-configure.json R3
reject bad-window.json R5
reject bad-server-slave.json R8
reject bad-server-contradictory.json R8
exit $fail
