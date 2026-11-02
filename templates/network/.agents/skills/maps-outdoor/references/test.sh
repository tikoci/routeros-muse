#!/bin/sh
# test.sh — maps-outdoor self-test (offline): build-outdoor.py emits page +
# KML + layer record from the synthetic fixture; asserts labels, offline
# purity, KML validity + counts + coords, privacy (no owner fields), schema.
# Needs: sh, python3.
set -eu
refs=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
command -v python3 >/dev/null 2>&1 || { echo "FAIL: missing python3"; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM
fail=0

python3 "$refs/build-outdoor.py" --fixtures "$refs/fixtures" --out "$work/out"
html="$work/out/outdoor.html"
kml="$work/out/outdoor.kml"
md="$work/out/outdoor-layers.md"
for f in "$html" "$kml" "$md"; do
  if [ -f "$f" ]; then echo "ok views: $(basename "$f") exists";
  else echo "FAIL views: missing $(basename "$f")"; fail=1; fi
done
expect() {
  if grep -qF "$2" "$1"; then echo "ok html: $3";
  else echo "FAIL html: missing $3"; fail=1; fi
}
expect_absent() {
  if grep -qF "$2" "$1"; then echo "FAIL: unwanted $3 in $1"; fail=1;
  else echo "ok: no $3"; fi
}
expect "$html" "example-outdoor-link" "site id"
expect "$html" "link ridge-pole to barn-roof" "link question"
for layer in starlink lidar parcels solar; do
  expect "$html" "<h2>$layer</h2>" "layer section $layer"
done
expect "$html" "planning sketch, not a survey" "honesty label"
expect "$html" "SYNTHETIC EXAMPLE" "synthetic marker"
expect_absent "$html" "http" "external refs"
expect_absent "$html" "fetch(" "fetch calls"
expect_absent "$html" "owner_name" "owner-name field"
expect_absent "$kml" "owner_name" "owner-name field in KML"
expect_absent "$md" "owner_name" "owner-name field in record"

python3 - "$kml" "$refs/fixtures/outdoor.json" <<'EOF'
import json, sys, xml.etree.ElementTree as ET
kml_path, fx_path = sys.argv[1], sys.argv[2]
fx = json.load(open(fx_path))
ns = {"k": "http://www.opengis.net/kml/2.2"}
root = ET.parse(kml_path).getroot()  # raises if not well-formed XML
pms = root.findall(".//k:Placemark", ns)
spots = sum(1 for l in fx["layers"].values() if l.get("dish_spot") or l.get("spot"))
want = len(fx["devices"]) + spots + 1  # devices + spots + link LineString
assert len(pms) == want, f"want {want} Placemarks, got {len(pms)}"
by_device = {d["device"]: d for d in fx["devices"]}
for d in fx["devices"]:
    coord = f"{d['lon']},{d['lat']},0"
    found = [p for p in pms if p.findtext("k:name", "", ns) == d["device"]]
    assert found, f"no Placemark for {d['device']}"
    got = found[0].findtext(".//k:coordinates", "", ns)
    assert got == coord, f"{d['device']}: want {coord}, got {got}"
a, b = by_device[fx["link"]["from"]], by_device[fx["link"]["to"]]
want_line = f"{a['lon']},{a['lat']},0 {b['lon']},{b['lat']},0"
lines = [p.findtext(".//k:coordinates", "", ns) for p in pms]
assert want_line in lines, f"link LineString mismatch: {lines}"
print(f"ok kml: {len(pms)} Placemarks, device coords + link path match fixtures")
EOF
[ $? -ne 0 ] && fail=1

TMPD=$(mktemp -d)
cp "$refs/fixtures/outdoor.json" "$TMPD/outdoor.json"
python3 - "$TMPD/outdoor.json" <<'EOF'
import json, sys
p = sys.argv[1]
fx = json.load(open(p))
del fx["layers"]["solar"]
json.dump(fx, open(p, "w"))
EOF
if python3 "$refs/build-outdoor.py" --fixtures "$TMPD" --out "$TMPD/out" >/dev/null 2>&1; then
  echo "FAIL schema: broken fixture accepted"; fail=1
else echo "ok schema: broken fixture rejected"; fi
rm -rf "$TMPD"
exit $fail
