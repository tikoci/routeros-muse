#!/usr/bin/env sh
# test.sh — vendor-conversion self-test (offline, stdlib only).
# Proves: schema validation, per-step provenance, lazy counting, synthetic marking.
set -eu
HERE=$(dirname "$0")
FIX="$HERE/fixtures/old-site-ubnt.json"
fails=0
pass() { echo "ok: $1"; }
fail() { echo "FAIL: $1"; fails=$((fails + 1)); }

# 1. planner exits 0 on the fixture
if OUT=$(python3 "$HERE/plan-from-capture.py" "$FIX" 2>"$HERE/.stderr"); then
  pass "planner exit 0 on fixture"
else
  fail "planner exit non-zero on fixture"; cat "$HERE/.stderr"
fi
rm -f "$HERE/.stderr"

# 2. every STEP line carries exactly one provenance marker
TOTAL=$(printf '%s\n' "$OUT" | grep -c '^- STEP ' || true)
MARKED=$(printf '%s\n' "$OUT" | grep -c '^- STEP .*<- \(capture\|absence\|lazy\):' || true)
if [ "$TOTAL" -ge 11 ] && [ "$TOTAL" = "$MARKED" ]; then
  pass "all $TOTAL steps carry provenance"
else
  fail "provenance: $MARKED/$TOTAL steps marked"
fi

# 3. lazy count line present and consistent with lazy steps
LAZYLINE=$(printf '%s\n' "$OUT" | grep '^# lazy count: ' | grep -o '[0-9]*' | head -1)
LAZYSTEPS=$(printf '%s\n' "$OUT" | grep -c '<- lazy:' || true)
if [ -n "$LAZYLINE" ] && [ "$LAZYLINE" = "$LAZYSTEPS" ] && [ "$LAZYSTEPS" -ge 1 ]; then
  pass "lazy count $LAZYLINE matches $LAZYSTEPS lazy steps"
else
  fail "lazy count line=$LAZYLINE steps=$LAZYSTEPS"
fi

# 4. synthetic example is marked as such
if printf '%s\n' "$OUT" | grep -q 'SYNTHETIC EXAMPLE'; then
  pass "synthetic marker present"
else
  fail "synthetic marker missing"
fi

# 5. no real-looking private IPs leak into the plan (fixture is TEST-NET-2)
if printf '%s\n' "$OUT" | grep -Eq '192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.'; then
  fail "non-documentation IP found in plan output"
else
  pass "documentation IPs only"
fi

# 6. negative: broken capture (missing key) exits non-zero
TMPD=$(mktemp -d)
python3 - "$FIX" "$TMPD/broken.json" <<'EOF'
import json, sys
cap = json.load(open(sys.argv[1]))
del cap["absences"]
json.dump(cap, open(sys.argv[2], "w"))
EOF
if python3 "$HERE/plan-from-capture.py" "$TMPD/broken.json" >/dev/null 2>&1; then
  fail "broken capture accepted"
else
  pass "broken capture rejected"
fi
rm -rf "$TMPD"

# 7. negative: empty absences rejected (skipped-question guard)
TMPD=$(mktemp -d)
python3 - "$FIX" "$TMPD/empty.json" <<'EOF'
import json, sys
cap = json.load(open(sys.argv[1]))
cap["absences"] = []
json.dump(cap, open(sys.argv[2], "w"))
EOF
if python3 "$HERE/plan-from-capture.py" "$TMPD/empty.json" >/dev/null 2>&1; then
  fail "empty absences accepted"
else
  pass "empty absences rejected"
fi
rm -rf "$TMPD"

if [ "$fails" -ne 0 ]; then echo "$fails FAILURE(S)"; exit 1; fi
echo "all vendor-conversion self-tests passed"
