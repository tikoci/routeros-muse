#!/bin/sh
# Self-test for unbox-provision references: static contract only,
# no router needed. Asserts the device-record shape, the baseline
# render hygiene (placeholders, no live secrets), and the twin-run
# citation (date + proof target) the gate requires. Needs: sh, grep.
set -eu
refs=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
skill_dir=$(dirname -- "$refs")
fail=0
pass() { echo "ok: $1"; }
failf() { echo "FAIL: $1"; fail=1; }

# 1. device-record fixture carries every slot-vs-label binding key.
for k in device label_model label_serial label_mac bound_at bound_by \
    password_ref rendered_baseline first_pull; do
  if grep -q "^$k = " "$refs/device-record.example.toml"; then pass "device key $k";
  else failf "device-record.example.toml missing key $k"; fi
done
# password_ref must be a POINTER (path), never an inline secret.
if grep "^password_ref" "$refs/device-record.example.toml" | grep -q "private/"; then
  pass "password_ref is a private-file pointer"
else failf "password_ref must point at private/<device>.txt"; fi

# 2. baseline render: executed subset present, secrets placeholder-only.
for line in '/system/identity/set' '/system/note/set'; do
  if grep -q "$line" "$refs/baseline-render.example.rsc"; then pass "render has $line";
  else failf "baseline-render.example.rsc missing $line"; fi
done
if grep -q "PLACEHOLDER-FILL-AT-UPLOAD" "$refs/baseline-render.example.rsc"; then
  pass "render secrets are placeholders"
else failf "render must mark secrets PLACEHOLDER-FILL-AT-UPLOAD"; fi
live_secret=$(grep -E "password=|secret=|community=" "$refs/baseline-render.example.rsc" | grep -v "PLACEHOLDER" || true)
if [ -z "$live_secret" ]; then pass "no live secrets in render";
else failf "live secret in render: $live_secret"; fi

# 3. twin-run citation: date + proof target (gate rule, pinned here).
if grep -qE "[0-9]{4}-[0-9]{2}-[0-9]{2}" "$refs/twin-run.md"; then
  pass "twin-run.md cites a date"
else failf "twin-run.md must cite a date (YYYY-MM-DD)"; fi
if grep -qiE "twin|chr|hardware|routeros" "$refs/twin-run.md"; then
  pass "twin-run.md names the proof target"
else failf "twin-run.md must name the proof target"; fi
if grep -q "KVM host" "$refs/twin-run.md"; then pass "twin-run.md cites the machine";
else failf "twin-run.md must cite the machine"; fi

# 4. frontmatter contract of the owning SKILL.md.
front=$(sed -n '/^---$/,/^---$/p' "$skill_dir/SKILL.md")
case "$front" in *'name: unbox-provision'*) pass "frontmatter name";; *) failf "frontmatter name mismatch";; esac
case "$front" in *'topics: [provisioning, inventory]'*) pass "frontmatter topics";; *) failf "frontmatter topics";; esac
case "$front" in *'requires: [twin]'*) pass "frontmatter requires";; *) failf "frontmatter requires";; esac
case "$front" in *'tested: twin-run'*) pass "frontmatter tested";; *) failf "frontmatter tested";; esac

exit $fail
