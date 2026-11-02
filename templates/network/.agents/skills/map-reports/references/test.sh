#!/bin/sh
# Proves the map-reports render pipeline on SYNTHETIC fixtures (no real
# places, no network): build-map.ts emits a self-contained Leaflet page +
# KML truth from fixtures/, then headless chromium screenshots the page.
# Asserts: page carries fixture devices + source labels + coverage honesty
# label + Fix-GPS hook; page initiates zero network requests; KML parses
# with matching Placemarks/coords; PNG is exactly 1080x1350 and non-blank.
# Needs: sh, bun, chromium (or google-chrome), python3.
set -eu
refs=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for t in bun python3; do
  command -v "$t" >/dev/null 2>&1 || { echo "FAIL: missing $t"; exit 1; }
done
if command -v chromium >/dev/null 2>&1; then CHROME=chromium
elif command -v google-chrome >/dev/null 2>&1; then CHROME=google-chrome
elif command -v chromium-browser >/dev/null 2>&1; then CHROME=chromium-browser
else echo "FAIL: missing chromium (or google-chrome)"; exit 1; fi
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

bun "$refs/build-map.ts" --fixtures "$refs/fixtures" --vendor "$refs/vendor" --out "$work/out"
html="$work/out/site-map.html"
kml="$work/out/sites.kml"
fail=0
expect() { # expect <file> <fixed-string> <label>
  if grep -qF "$2" "$1"; then echo "ok html: $3";
  else echo "FAIL html: missing $3"; fail=1; fi
}
expect_absent() { # expect_absent <file> <fixed-string> <label>
  if grep -qF "$2" "$1"; then echo "FAIL html: unwanted $3"; fail=1;
  else echo "ok html: no $3"; fi
}
expect "$html" "fixture-core" "device fixture-core"
expect "$html" "fixture-pole-1" "device fixture-pole-1"
expect "$html" "leaflet" "Leaflet library inlined"
expect "$html" "A sketch, not a survey" "coverage honesty label"
expect "$html" "OpenStreetMap contributors" "OSM source label"
expect "$html" "USGS 3DEP" "hillshade source label"
expect "$html" "Copy correction for your agent" "Fix-GPS portable wording"
expect "$html" "status=proposed" "proposed-vs-applied marking"
expect "$html" "Revision" "revision identifier"
expect_absent "$html" "L.tileLayer(" "tile layer (fixture renders offline)"
expect_absent "$html" "fetch(" "fetch calls"
expect_absent "$html" "XMLHttpRequest" "XHR calls"

python3 - "$kml" "$refs/fixtures/sites.json" <<'EOF'
import json, sys, xml.etree.ElementTree as ET
kml_path, sites_path = sys.argv[1], sys.argv[2]
sites = json.load(open(sites_path))
ns = {"k": "http://www.opengis.net/kml/2.2"}
root = ET.parse(kml_path).getroot()  # raises if not well-formed XML
pms = root.findall(".//k:Placemark", ns)
want = len(sites["devices"]) + len(sites["links"])
assert len(pms) == want, f"want {want} Placemarks, got {len(pms)}"
for d in sites["devices"]:
    coord = f"{d['lon']},{d['lat']},0"
    found = [p for p in pms if p.findtext("k:name", "", ns) == d["device"]]
    assert found, f"no Placemark for {d['device']}"
    got = found[0].findtext(".//k:coordinates", "", ns)
    assert got == coord, f"{d['device']}: want {coord}, got {got}"
print(f"ok kml: {len(pms)} Placemarks, device coords match fixtures")
EOF
[ $? -ne 0 ] && fail=1

"$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --virtual-time-budget=3000 --screenshot="$work/out/map.png" \
  --window-size=1080,1350 "file://$html" >/dev/null 2>&1
if [ -f "$work/out/map.png" ]; then echo "ok png: rendered";
else echo "FAIL png: no screenshot"; fail=1; fi
if [ "$fail" -eq 0 ]; then
  python3 "$refs/check-png.py" "$work/out/map.png" 1080 1350 64 || fail=1
fi
exit $fail
