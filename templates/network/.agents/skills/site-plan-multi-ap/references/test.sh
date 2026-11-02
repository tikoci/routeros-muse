#!/bin/sh
# test.sh — site-plan-multi-ap self-test (offline): render-site-plan.py emits
# schematic SVG + AP table + shot wrapper from the synthetic fixture; asserts
# markers, model citations, warning count, SVG validity, PNG, and schema.
# Needs: sh, python3, chromium (or google-chrome).
set -eu
refs=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
command -v python3 >/dev/null 2>&1 || { echo "FAIL: missing python3"; exit 1; }
if command -v chromium >/dev/null 2>&1; then CHROME=chromium
elif command -v google-chrome >/dev/null 2>&1; then CHROME=google-chrome
elif command -v chromium-browser >/dev/null 2>&1; then CHROME=chromium-browser
else echo "FAIL: missing chromium (or google-chrome)"; exit 1; fi
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM
fail=0

python3 "$refs/render-site-plan.py" --fixtures "$refs/fixtures" --out "$work/out"
svg="$work/out/site-plan.svg"
md="$work/out/site-plan.md"
for f in "$svg" "$md" "$work/out/shot.html"; do
  if [ -f "$f" ]; then echo "ok views: $(basename "$f") exists";
  else echo "FAIL views: missing $(basename "$f")"; fail=1; fi
done
python3 - "$svg" <<'EOF'
import sys, xml.etree.ElementTree as ET
ET.parse(sys.argv[1])  # raises if not well-formed XML
print("ok svg: parses as XML")
EOF
[ $? -ne 0 ] && fail=1
for device in fx-ap-living fx-ap-office fx-ap-upper; do
  if grep -qF "$device" "$svg"; then echo "ok svg: marker $device";
  else echo "FAIL svg: missing marker $device"; fail=1; fi
done
if grep -qF "estimate" "$svg"; then echo "ok svg: estimate legend";
else echo "FAIL svg: estimate legend"; fail=1; fi
if grep -qF "cAP RBcAP2nD" "$md" && grep -qF "wAP LR2" "$md"; then
  echo "ok md: model citations present"
else echo "FAIL md: model citations"; fail=1; fi
WARNLINES=$(grep -c '^WARN: same-channel adjacent' "$md" || true)
WARNCOUNT=$(grep '^warnings: ' "$md" | grep -o '[0-9]*' | head -1)
if [ "$WARNLINES" = "1" ] && [ "$WARNCOUNT" = "1" ]; then
  echo "ok md: exactly 1 channel warning, count consistent"
else echo "FAIL md: warnings lines=$WARNLINES count=$WARNCOUNT"; fail=1; fi

# window height must cover the stacked panels: 150 + 2 floors*(420+40) = 1070
# Chromium litters $TMPDIR (url_fetcher dirs); point it at the
# trap-cleaned work dir so the gate tmpdir stays clean.
TMPDIR="$work" "$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --virtual-time-budget=3000 --screenshot="$work/out/site-plan.png" \
  --window-size=1080,1350 "file://$work/out/shot.html" >/dev/null 2>&1
if [ -f "$work/out/site-plan.png" ]; then echo "ok png: rendered";
else echo "FAIL png: no screenshot"; fail=1; fi
if [ "$fail" -eq 0 ]; then
  python3 "$refs/check-png.py" "$work/out/site-plan.png" 1080 1350 32 || fail=1
fi

TMPD=$(mktemp -d)
cp "$refs/fixtures/site.json" "$TMPD/site.json"
python3 - "$TMPD/site.json" <<'EOF'
import json, sys
p = sys.argv[1]
fx = json.load(open(p))
del fx["aps"][0]["channel"]
json.dump(fx, open(p, "w"))
EOF
if python3 "$refs/render-site-plan.py" --fixtures "$TMPD" --out "$TMPD/out" >/dev/null 2>&1; then
  echo "FAIL schema: broken fixture accepted"; fail=1
else echo "ok schema: broken fixture rejected"; fi
rm -rf "$TMPD"
exit $fail
