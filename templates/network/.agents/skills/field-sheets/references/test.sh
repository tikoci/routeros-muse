#!/bin/sh
# test.sh — field-sheets self-test (offline): render-sheet.py emits one
# phone-portrait page per fixture location; asserts labels/ports/compass
# words/expected+stop/revision, no external refs, broken spec rejected,
# and a 1080x1350 non-blank PNG via headless chromium.
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

python3 "$refs/render-sheet.py" --spec "$refs/fixtures/sheets.json" --out "$work/out"
for device in fx-pole-1 fx-cupboard; do
  if [ -f "$work/out/sheet-$device.html" ]; then echo "ok views: sheet-$device.html exists";
  else echo "FAIL views: missing sheet-$device.html"; fail=1; fi
done
page="$work/out/sheet-fx-pole-1.html"
expect() {
  if grep -qF "$1" "$page"; then echo "ok html: $2";
  else echo "FAIL html: missing $2"; fail=1; fi
}
expect "AP-POLE-1" "device label"
expect "ether1" "port naming"
expect "northeast toward the barn" "compass-words aiming"
expect "You should see:" "expected-result line"
expect "If not, STOP:" "stop-condition line"
expect "fx-2026-10-31-01" "revision id"
expect "never hand-edited" "generated-from-records line"
if grep -qE 'src="http|href="http|url\(http' "$page"; then
  echo "FAIL html: external refs (must render offline)"; fail=1
else echo "ok html: no external refs"; fi
steps=$(grep -o "You should see:" "$page" | wc -l)
stops=$(grep -o "If not, STOP:" "$page" | wc -l)
if [ "$steps" = "3" ] && [ "$stops" = "3" ]; then
  echo "ok html: 3 steps each carry expected + stop"
else echo "FAIL html: steps=$steps stops=$stops (want 3/3)"; fail=1; fi

if python3 "$refs/render-sheet.py" --spec "$refs/fixtures/bad-sheets.json" \
    --out "$work/bad" 2>&1 | grep -q "needs a stop condition"; then
  echo "ok schema: stop-less step rejected"
else echo "FAIL schema: broken spec accepted"; fail=1; fi

"$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --virtual-time-budget=3000 --screenshot="$work/out/sheet.png" \
  --window-size=1080,1350 "file://$page" >/dev/null 2>&1
if [ -f "$work/out/sheet.png" ]; then echo "ok png: rendered";
else echo "FAIL png: no screenshot"; fail=1; fi
if [ "$fail" -eq 0 ]; then
  python3 "$refs/check-png.py" "$work/out/sheet.png" 1080 1350 32 || fail=1
fi
exit $fail
