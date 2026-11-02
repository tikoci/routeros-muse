#!/bin/sh
# test.sh — static self-test for wireless-vlan-setup (no router needed).
# Fails (exit 1) on the first missing load-bearing shape.
set -u
SKILL="$(dirname "$0")/../SKILL.md"
TWINRUN="$(dirname "$0")/twin-run.md"
fail() { echo "FAIL: $1" >&2; exit 1; }

[ -f "$SKILL" ] || fail "SKILL.md missing"
[ -f "$TWINRUN" ] || fail "twin-run.md missing"
grep -q '^name: wireless-vlan-setup$' "$SKILL" || fail "frontmatter name"
grep -q '^topics: \[wireless, vlan\]$' "$SKILL" || fail "frontmatter topics"
grep -q '^requires: \[twin\]$' "$SKILL" || fail "frontmatter requires"
grep -q '^tested: twin-run$' "$SKILL" || fail "frontmatter tested"
grep -q '^# ' "$SKILL" || fail "H1 after frontmatter"
[ "$(grep -c '^[0-9]\+\. \+[^ ]' "$SKILL")" -ge 3 ] || fail "Part 1 needs >=3 steps"
for h in Trigger Prereqs Access Envs Outputs Verification Recovery Limits; do
  grep -q "^### $h\$" "$SKILL" || fail "missing section $h"
done
grep -Eq '[0-9]{4}-[0-9]{2}-[0-9]{2}' "$TWINRUN" || fail "twin-run.md needs a date"
grep -Eqi 'twin|chr|hardware|routeros' "$TWINRUN" || fail "twin-run.md needs a target"
grep -qi 'kvm host' "$TWINRUN" || fail "twin-run.md needs the machine"
echo "PASS: wireless-vlan-setup static shapes ok"
