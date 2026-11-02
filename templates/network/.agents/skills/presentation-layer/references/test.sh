#!/bin/sh
# test.sh — presentation-layer self-test (offline): render-views.py emits
# four views from the synthetic fixture; asserts labels, offline purity,
# SVG validity, PNG dimensions + non-blank, link list, and schema rejection.
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

python3 "$refs/render-views.py" --fixtures "$refs/fixtures" --out "$work/out"
html="$work/out/views-local.html"
svg="$work/out/views-board.svg"
links="$work/out/views-links.md"
for f in "$html" "$svg" "$work/out/shot.html" "$links"; do
  if [ -f "$f" ]; then echo "ok views: $(basename "$f") exists";
  else echo "FAIL views: missing $(basename "$f")"; fail=1; fi
done
expect() {
  if grep -qF "$2" "$1"; then echo "ok html: $3";
  else echo "FAIL html: missing $3"; fail=1; fi
}
expect_absent() {
  if grep -qF "$2" "$1"; then echo "FAIL html: unwanted $3"; fail=1;
  else echo "ok html: no $3"; fi
}
expect "$html" "example-status-site" "site id"
expect "$html" "fx-ap-west" "degraded device"
expect "$html" "degraded" "status value"
expect "$html" "SYNTHETIC EXAMPLE" "synthetic marker"
expect "$html" "2026-10-30" "matrix date"
expect "$html" "generated from records fixture" "honesty label"
expect_absent "$html" "http" "external refs"
expect_absent "$html" "fetch(" "fetch calls"
expect_absent "$html" "<script" "script tags"
python3 - "$svg" <<'EOF'
import sys, xml.etree.ElementTree as ET
ET.parse(sys.argv[1])  # raises if not well-formed XML
print("ok svg: parses as XML")
EOF
[ $? -ne 0 ] && fail=1

# Chromium litters $TMPDIR (url_fetcher dirs); point it at the
# trap-cleaned work dir so the gate tmpdir stays clean.
TMPDIR="$work" "$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --virtual-time-budget=3000 --screenshot="$work/out/views-board.png" \
  --window-size=1080,1350 "file://$work/out/shot.html" >/dev/null 2>&1
if [ -f "$work/out/views-board.png" ]; then echo "ok png: rendered";
else echo "FAIL png: no screenshot"; fail=1; fi
if [ "$fail" -eq 0 ]; then
  python3 "$refs/check-png.py" "$work/out/views-board.png" 1080 1350 32 || fail=1
fi

if grep -qF "#/wireless" "$links" && grep -qF "router.invalid" "$links"; then
  echo "ok links: webfig fragments on documentation host"
else echo "FAIL links: fragments/host"; fail=1; fi
if grep -qF "local workstation agent" "$links" && grep -qF "sandboxed agent app" "$links"; then
  echo "ok links: harness routing present"
else echo "FAIL links: harness routing"; fail=1; fi

TMPD=$(mktemp -d)
cp "$refs/fixtures/findings.json" "$TMPD/findings.json"
python3 - "$TMPD/findings.json" <<'EOF'
import json, sys
p = sys.argv[1]
fx = json.load(open(p))
del fx["devices"]
json.dump(fx, open(p, "w"))
EOF
if python3 "$refs/render-views.py" --fixtures "$TMPD" --out "$TMPD/out" >/dev/null 2>&1; then
  echo "FAIL schema: broken fixture accepted"; fail=1
else echo "ok schema: broken fixture rejected"; fi
rm -rf "$TMPD"
exit $fail
